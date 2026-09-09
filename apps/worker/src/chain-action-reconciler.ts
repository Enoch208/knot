import type {
  ChainActionRecord,
} from "../../../packages/db/src/chain-action-repository.ts"
import { LeaseRejectedError } from "../../../packages/db/src/index.ts"
import type { ChainActionState, WorkerLease } from "../../../packages/db/src/index.ts"

export interface ChainReceiptObservation {
  chainId: 56 | 97
  transactionHash: string
  transactionIntentHash: string
  signerAddress: string
  nonce: string | null
  status: "SUCCESS" | "REVERTED"
  blockNumber: string
  blockHash: string
  confirmations: number
  observedAtUtc: string
}

export interface ChainReceiptObserver {
  observe(action: ChainActionRecord, signal: AbortSignal): Promise<ChainReceiptObservation | null>
}

export interface ChainActionTransitioner {
  transition(
    actionId: string,
    expectedVersion: number,
    nextState: ChainActionState,
    transactionHash: string | null,
    reconciliation: Readonly<Record<string, unknown>>,
    lease: WorkerLease,
  ): Promise<ChainActionRecord>
}

export type ChainReconciliationReason =
  | "PREPARED_BROADCAST_UNKNOWN"
  | "PREPARED_TRANSACTION_FOUND"
  | "ALREADY_TERMINAL"
  | "RECEIPT_UNAVAILABLE"
  | "OBSERVATION_INVALID"
  | "OBSERVATION_MISMATCH"
  | "AWAITING_CONFIRMATIONS"
  | "CONFIRMED_SUCCESS"
  | "CONFIRMED_REVERT"

export interface ChainReconciliationDecision {
  nextState: "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN" | null
  transactionHash: string | null
  reason: ChainReconciliationReason
  reconciliation: Readonly<Record<string, unknown>>
}

export interface ChainReconciliationResult {
  action: ChainActionRecord
  changed: boolean
  decision: ChainReconciliationDecision
}

const hashPattern = /^0x[0-9a-fA-F]{64}$/
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const integerPattern = /^(0|[1-9][0-9]*)$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

export class ChainActionReconciler {
  private readonly observer: ChainReceiptObserver
  private readonly actions: ChainActionTransitioner
  private readonly confirmationPolicy: Readonly<Record<56 | 97, number>>
  private readonly now: () => Date
  private readonly observationTimeoutMilliseconds: number

  constructor(
    observer: ChainReceiptObserver,
    actions: ChainActionTransitioner,
    confirmationPolicy: Readonly<Record<56 | 97, number>>,
    now: () => Date = () => new Date(),
    observationTimeoutMilliseconds = 10_000,
  ) {
    for (const chainId of [56, 97] as const) {
      const confirmations = confirmationPolicy[chainId]
      if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 100) {
        throw new RangeError("confirmation policy is outside its supported range")
      }
    }
    if (
      !Number.isSafeInteger(observationTimeoutMilliseconds) ||
      observationTimeoutMilliseconds < 1 ||
      observationTimeoutMilliseconds > 300_000
    ) {
      throw new RangeError("observation timeout is outside its supported range")
    }
    this.observer = observer
    this.actions = actions
    this.confirmationPolicy = confirmationPolicy
    this.now = now
    this.observationTimeoutMilliseconds = observationTimeoutMilliseconds
  }

  async reconcile(
    action: ChainActionRecord,
    lease: WorkerLease,
    signal?: AbortSignal,
  ): Promise<ChainReconciliationResult> {
    signal?.throwIfAborted()
    if (action.state === "CONFIRMED" || action.state === "FAILED") {
      return unchanged(action, "ALREADY_TERMINAL")
    }

    const remainingLeaseMilliseconds = lease.expiresAt.getTime() - this.now().getTime()
    if (remainingLeaseMilliseconds <= 1_000) throw new LeaseRejectedError()

    let observation: ChainReceiptObservation | null
    try {
      observation = await this.observe(
        action,
        Math.min(this.observationTimeoutMilliseconds, remainingLeaseMilliseconds - 1_000),
        signal,
      )
    } catch (error) {
      if (signal?.aborted) throw error
      observation = null
    }
    signal?.throwIfAborted()
    const decision = decideChainReconciliation(
      action,
      observation,
      this.confirmationPolicy[action.chainId],
      this.now().getTime(),
    )
    if (decision.nextState === null) return { action, changed: false, decision }
    signal?.throwIfAborted()
    const updated = await this.actions.transition(
      action.id,
      action.version,
      decision.nextState,
      decision.transactionHash,
      decision.reconciliation,
      lease,
    )
    return { action: updated, changed: true, decision }
  }

  private async observe(
    action: ChainActionRecord,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<ChainReceiptObservation | null> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(null)
      }, timeoutMilliseconds)
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
    try {
      return await Promise.race([this.observer.observe(action, controller.signal), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }
}

function decideChainReconciliation(
  action: ChainActionRecord,
  observation: ChainReceiptObservation | null,
  minimumConfirmations: number,
  nowMs: number,
): ChainReconciliationDecision {
  if (action.state === "CONFIRMED" || action.state === "FAILED") {
    return decision(null, action.transactionHash, "ALREADY_TERMINAL", true)
  }
  if (action.state === "SUBMITTED" && (action.transactionHash === null || !hashPattern.test(action.transactionHash))) {
    return unresolved(action, "OBSERVATION_INVALID")
  }
  if (observation === null) {
    if (action.state === "PREPARED") return decision("UNKNOWN", null, "PREPARED_BROADCAST_UNKNOWN", false)
    return unresolved(action, "RECEIPT_UNAVAILABLE")
  }
  if (!validObservation(observation, nowMs)) {
    if (action.state === "PREPARED") return decision("UNKNOWN", null, "PREPARED_BROADCAST_UNKNOWN", false)
    return unresolved(action, "OBSERVATION_INVALID")
  }
  const matches = observation.chainId === action.chainId
    && observation.transactionIntentHash.toLowerCase() === action.requestHash.toLowerCase()
    && observation.signerAddress.toLowerCase() === action.signerAddress.toLowerCase()
    && observation.nonce === action.nonce
    && (action.transactionHash === null
      || observation.transactionHash.toLowerCase() === action.transactionHash.toLowerCase())
  if (!matches) {
    if (action.state === "PREPARED") return decision("UNKNOWN", null, "PREPARED_BROADCAST_UNKNOWN", false)
    return unresolved(action, "OBSERVATION_MISMATCH")
  }
  if (action.state === "PREPARED") {
    return decision("SUBMITTED", observation.transactionHash, "PREPARED_TRANSACTION_FOUND", true, observation)
  }
  if (observation.confirmations < minimumConfirmations) {
    return unresolved(action, "AWAITING_CONFIRMATIONS", observation)
  }
  const nextState = observation.status === "SUCCESS" ? "CONFIRMED" : "FAILED"
  const reason = observation.status === "SUCCESS" ? "CONFIRMED_SUCCESS" : "CONFIRMED_REVERT"
  return decision(nextState, observation.transactionHash, reason, true, observation)
}

function unresolved(
  action: ChainActionRecord,
  reason: Extract<ChainReconciliationReason, "RECEIPT_UNAVAILABLE" | "OBSERVATION_INVALID" | "OBSERVATION_MISMATCH" | "AWAITING_CONFIRMATIONS">,
  observation?: ChainReceiptObservation,
): ChainReconciliationDecision {
  const nextState = action.state === "SUBMITTED" ? "UNKNOWN" : null
  return decision(nextState, action.transactionHash, reason, false, observation)
}

function decision(
  nextState: "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN" | null,
  transactionHash: string | null,
  reason: ChainReconciliationReason,
  bindingMatched: boolean,
  observation?: ChainReceiptObservation,
): ChainReconciliationDecision {
  return {
    nextState,
    transactionHash,
    reason,
    reconciliation: {
      reason,
      bindingMatched,
      ...(observation === undefined ? {} : {
        observedAtUtc: observation.observedAtUtc,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        confirmations: observation.confirmations,
        receiptStatus: observation.status,
        transactionHash: observation.transactionHash,
        transactionIntentHash: observation.transactionIntentHash,
        signerAddress: observation.signerAddress,
        nonce: observation.nonce,
      }),
    },
  }
}

function unchanged(action: ChainActionRecord, reason: "ALREADY_TERMINAL"): ChainReconciliationResult {
  return { action, changed: false, decision: decision(null, action.transactionHash, reason, true) }
}

function validObservation(observation: ChainReceiptObservation, nowMs: number): boolean {
  const observedAtMs = Date.parse(observation.observedAtUtc)
  const canonicalTimestamp = Number.isFinite(observedAtMs)
    ? new Date(observedAtMs).toISOString()
    : ""
  const expectedTimestamp = observation.observedAtUtc.endsWith(".000Z")
    ? canonicalTimestamp
    : canonicalTimestamp.replace(/\.000Z$/, "Z")
  return hashPattern.test(observation.transactionHash)
    && hashPattern.test(observation.transactionIntentHash)
    && addressPattern.test(observation.signerAddress)
    && (observation.nonce === null || integerPattern.test(observation.nonce))
    && (observation.status === "SUCCESS" || observation.status === "REVERTED")
    && integerPattern.test(observation.blockNumber)
    && hashPattern.test(observation.blockHash)
    && Number.isInteger(observation.confirmations)
    && observation.confirmations >= 0
    && observation.confirmations <= 10_000_000
    && timestampPattern.test(observation.observedAtUtc)
    && Number.isFinite(observedAtMs)
    && expectedTimestamp === observation.observedAtUtc
    && observedAtMs <= nowMs + 60_000
}
