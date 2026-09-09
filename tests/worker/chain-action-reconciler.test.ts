import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ChainActionReconciler,
  type ChainActionTransitioner,
  type ChainReceiptObservation,
  type ChainReceiptObserver,
} from "../../apps/worker/src/chain-action-reconciler.ts"
import type { ChainActionRecord } from "../../packages/db/src/chain-action-repository.ts"
import { LeaseRejectedError, type ChainActionState, type WorkerLease } from "../../packages/db/src/index.ts"

const transactionHash = `0x${"1".repeat(64)}`
const requestHash = `0x${"2".repeat(64)}` as const
const blockHash = `0x${"3".repeat(64)}`
const signerAddress = `0x${"4".repeat(40)}` as const
const confirmationPolicy = { 56: 15, 97: 2 } as const
const now = () => new Date("2026-09-09T17:01:00Z")

const lease: WorkerLease = {
  jobId: "job-1",
  workerId: "reconciler-1",
  fencingToken: "9",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
}

const submitted = (state: ChainActionState = "SUBMITTED", version = 4): ChainActionRecord => ({
  id: "action-1",
  jobId: lease.jobId,
  sessionId: "session-1",
  taskId: "task-1",
  actionSequence: 0,
  semanticAction: "fund",
  signerAddress,
  accountAddress: signerAddress,
  chainId: 97,
  nonce: "17",
  relayIntentId: null,
  requestHash,
  transactionIntent: {
    schemaVersion: "knot.evm-transaction-intent/1",
    taskId: "task-1",
    actionSequence: 0,
    semanticAction: "fund",
    signerAddress,
    accountAddress: signerAddress,
    chainId: 97,
    nonce: "17",
    destination: signerAddress,
    valueUnits: "0",
    calldataHash: requestHash,
    gasLimit: "21000",
    gasPriceUnits: "1",
  },
  transactionHash,
  state,
  reconciliation: {},
  version,
})

const observed = (overrides: Partial<ChainReceiptObservation> = {}): ChainReceiptObservation => ({
  chainId: 97,
  transactionHash,
  transactionIntentHash: requestHash,
  signerAddress,
  nonce: "17",
  status: "SUCCESS",
  blockNumber: "123",
  blockHash,
  confirmations: 3,
  observedAtUtc: "2026-09-09T17:00:00Z",
  ...overrides,
})

class MemoryTransitions implements ChainActionTransitioner {
  readonly calls: Array<{
    actionId: string
    expectedVersion: number
    nextState: ChainActionState
    transactionHash: string | null
    reconciliation: Readonly<Record<string, unknown>>
    lease: WorkerLease
  }> = []

  async transition(
    actionId: string,
    expectedVersion: number,
    nextState: ChainActionState,
    observedTransactionHash: string | null,
    reconciliation: Readonly<Record<string, unknown>>,
    observedLease: WorkerLease,
  ): Promise<ChainActionRecord> {
    this.calls.push({ actionId, expectedVersion, nextState, transactionHash: observedTransactionHash, reconciliation, lease: observedLease })
    return { ...submitted(nextState, expectedVersion + 1), transactionHash: observedTransactionHash, reconciliation }
  }
}

const observer = (value: ChainReceiptObservation | null): ChainReceiptObserver => ({
  observe: async () => value,
})

describe("chain action crash reconciliation", () => {
  it("confirms a bound successful receipt using the existing transaction only", async () => {
    const transitions = new MemoryTransitions()
    const result = await new ChainActionReconciler(observer(observed()), transitions, confirmationPolicy, now).reconcile(submitted(), lease)
    assert.equal(result.changed, true)
    assert.equal(result.action.state, "CONFIRMED")
    assert.equal(result.decision.reason, "CONFIRMED_SUCCESS")
    assert.equal(transitions.calls.length, 1)
    assert.deepEqual(transitions.calls[0], {
      actionId: "action-1",
      expectedVersion: 4,
      nextState: "CONFIRMED",
      transactionHash,
      reconciliation: result.decision.reconciliation,
      lease,
    })
  })

  it("records a bound reverted receipt as failed", async () => {
    const transitions = new MemoryTransitions()
    const result = await new ChainActionReconciler(
      observer(observed({ status: "REVERTED" })),
      transitions,
      confirmationPolicy,
      now,
    ).reconcile(submitted(), lease)
    assert.equal(result.action.state, "FAILED")
    assert.equal(result.decision.reason, "CONFIRMED_REVERT")
    assert.equal(transitions.calls.length, 1)
  })

  it("moves a submitted action with no receipt to unknown without resubmitting", async () => {
    const transitions = new MemoryTransitions()
    const reconciler = new ChainActionReconciler(observer(null), transitions, confirmationPolicy, now)
    const first = await reconciler.reconcile(submitted(), lease)
    assert.equal(first.action.state, "UNKNOWN")
    assert.equal(first.decision.reason, "RECEIPT_UNAVAILABLE")
    const second = await reconciler.reconcile(first.action, lease)
    assert.equal(second.changed, false)
    assert.equal(second.action.state, "UNKNOWN")
    assert.equal(transitions.calls.length, 1)
  })

  it("bounds a hung receipt observation and preserves unknown-outcome handling", async () => {
    let aborted = false
    const receiptObserver: ChainReceiptObserver = {
      observe: async (_action, signal) => await new Promise<null>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true
          resolve(null)
        }, { once: true })
      }),
    }
    const transitions = new MemoryTransitions()
    const result = await new ChainActionReconciler(
      receiptObserver,
      transitions,
      confirmationPolicy,
      now,
      5,
    ).reconcile(submitted(), lease)
    assert.equal(aborted, true)
    assert.equal(result.action.state, "UNKNOWN")
    assert.equal(result.decision.reason, "RECEIPT_UNAVAILABLE")
    assert.equal(transitions.calls.length, 1)
  })

  it("propagates shutdown abort without rewriting an unresolved action", async () => {
    const controller = new AbortController()
    let aborted = false
    const receiptObserver: ChainReceiptObserver = {
      observe: async (_action, signal) => await new Promise<null>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(signal.reason)
        }, { once: true })
      }),
    }
    const transitions = new MemoryTransitions()
    const reconciliation = new ChainActionReconciler(
      receiptObserver,
      transitions,
      confirmationPolicy,
      now,
      60_000,
    ).reconcile(submitted(), lease, controller.signal)
    controller.abort(new Error("shutdown"))
    await assert.rejects(reconciliation, /shutdown/)
    assert.equal(aborted, true)
    assert.equal(transitions.calls.length, 0)
  })

  it("refuses mismatched transaction and intent observations", async () => {
    for (const mismatch of [
      observed({ transactionHash: `0x${"5".repeat(64)}` }),
      observed({ transactionIntentHash: `0x${"6".repeat(64)}` }),
    ]) {
      const transitions = new MemoryTransitions()
      const result = await new ChainActionReconciler(observer(mismatch), transitions, confirmationPolicy, now).reconcile(submitted(), lease)
      assert.equal(result.action.state, "UNKNOWN")
      assert.equal(result.decision.reason, "OBSERVATION_MISMATCH")
      assert.equal(result.decision.reconciliation.bindingMatched, false)
    }
  })

  it("waits in unknown until the required confirmation count is observed", async () => {
    const transitions = new MemoryTransitions()
    const result = await new ChainActionReconciler(
      observer(observed({ confirmations: 1 })),
      transitions,
      confirmationPolicy,
      now,
    ).reconcile(submitted(), lease)
    assert.equal(result.action.state, "UNKNOWN")
    assert.equal(result.decision.reason, "AWAITING_CONFIRMATIONS")
  })

  it("recovers a transaction found after a prepared-before-journal crash without resubmitting", async () => {
    const transitions = new MemoryTransitions()
    const reconciler = new ChainActionReconciler(observer(observed()), transitions, confirmationPolicy, now)
    const prepared = { ...submitted("PREPARED"), transactionHash: null }
    const recovered = await reconciler.reconcile(prepared, lease)
    assert.equal(recovered.action.state, "SUBMITTED")
    assert.equal(recovered.action.transactionHash, transactionHash)
    assert.equal(recovered.decision.reason, "PREPARED_TRANSACTION_FOUND")
    const confirmed = await reconciler.reconcile(recovered.action, lease)
    assert.equal(confirmed.action.state, "CONFIRMED")
    assert.equal(transitions.calls.length, 2)
  })

  it("leaves an unresolved prepared broadcast fenced instead of assuming it was never sent", async () => {
    const transitions = new MemoryTransitions()
    const prepared = { ...submitted("PREPARED"), transactionHash: null }
    const unresolved = await new ChainActionReconciler(observer(null), transitions, confirmationPolicy, now).reconcile(prepared, lease)
    assert.equal(unresolved.changed, true)
    assert.equal(unresolved.action.state, "UNKNOWN")
    assert.equal(unresolved.decision.reason, "PREPARED_BROADCAST_UNKNOWN")
    const repeated = await new ChainActionReconciler(observer(null), transitions, confirmationPolicy, now).reconcile(unresolved.action, lease)
    assert.equal(repeated.changed, false)
    assert.equal(repeated.action.state, "UNKNOWN")
    assert.equal(transitions.calls.length, 1)
  })

  it("recovers a durably fenced unknown action when nonce-bound evidence appears later", async () => {
    const transitions = new MemoryTransitions()
    const prepared = { ...submitted("PREPARED"), transactionHash: null }
    const unresolved = await new ChainActionReconciler(observer(null), transitions, confirmationPolicy, now).reconcile(prepared, lease)
    const recovered = await new ChainActionReconciler(observer(observed()), transitions, confirmationPolicy, now).reconcile(unresolved.action, lease)
    assert.equal(recovered.action.state, "CONFIRMED")
    assert.equal(recovered.action.transactionHash, transactionHash)
    assert.equal(recovered.decision.reason, "CONFIRMED_SUCCESS")
    assert.equal(transitions.calls.length, 2)
  })

  it("rejects malformed receipt status and future observation time", async () => {
    for (const malformed of [
      observed({ status: "GARBAGE" as ChainReceiptObservation["status"] }),
      observed({ observedAtUtc: "2999-01-01T00:00:00.000Z" }),
      observed({ observedAtUtc: "2026-02-31T00:00:00Z" }),
    ]) {
      const transitions = new MemoryTransitions()
      const result = await new ChainActionReconciler(observer(malformed), transitions, confirmationPolicy, now).reconcile(submitted(), lease)
      assert.equal(result.action.state, "UNKNOWN")
      assert.equal(result.decision.reason, "OBSERVATION_INVALID")
    }
  })

  it("does not observe or rewrite terminal actions", async () => {
    let observations = 0
    const receiptObserver: ChainReceiptObserver = {
      observe: async () => {
        observations += 1
        return observed()
      },
    }
    const transitions = new MemoryTransitions()
    const reconciler = new ChainActionReconciler(receiptObserver, transitions, confirmationPolicy, now)
    assert.equal((await reconciler.reconcile(submitted("CONFIRMED"), lease)).decision.reason, "ALREADY_TERMINAL")
    assert.equal((await reconciler.reconcile(submitted("FAILED"), lease)).decision.reason, "ALREADY_TERMINAL")
    assert.equal(observations, 0)
    assert.equal(transitions.calls.length, 0)
  })

  it("rejects invalid observation timeout configuration", () => {
    assert.throws(
      () => new ChainActionReconciler(observer(null), new MemoryTransitions(), confirmationPolicy, now, 0),
      /observation timeout/,
    )
  })

  it("does not start an observation without a safe lease margin", async () => {
    let observed = false
    const receiptObserver: ChainReceiptObserver = {
      observe: async () => {
        observed = true
        return null
      },
    }
    await assert.rejects(
      () => new ChainActionReconciler(receiptObserver, new MemoryTransitions(), confirmationPolicy, now).reconcile(
        submitted(),
        { ...lease, expiresAt: new Date("2026-09-09T17:01:00.500Z") },
      ),
      LeaseRejectedError,
    )
    assert.equal(observed, false)
  })
})
