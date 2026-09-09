import type { ExternalPaidJobFailureEvidence } from "./external-paid-job.ts"
import { verifyExternalPaidJobFailureEvidence } from "./external-paid-job.ts"

export const externalPaidJobTransactionNames = [
  "create",
  "register",
  "approve",
  "setBudget",
  "fund",
  "refund",
  "markExpired",
] as const

export type ExternalPaidJobTransactionName = (typeof externalPaidJobTransactionNames)[number]

export interface ExternalPaidJobLiveReceipt {
  transactionHash: string
  status: "success" | "reverted"
  blockNumber: string
  blockHash: string
  timestamp: string
  gasUsed: string
  effectiveGasPriceWei: string
  to: string | null
}

export interface ExternalPaidJobLiveObservation {
  chainId: number
  observedAtUtc: string
  receipts: Record<ExternalPaidJobTransactionName, ExternalPaidJobLiveReceipt>
  owner: string
  paymentToken: string
  jobPolicy: string
  job: {
    id: string
    client: string
    provider: string
    evaluator: string
    description: string
    budget: string
    expiredAt: string
    status: number
    hook: string
    deliverable: string
    submittedAt: string
  }
  events: {
    created: ExternalPaidJobFailureEvidence["events"]["created"]
    registered: ExternalPaidJobFailureEvidence["events"]["registered"]
    funded: ExternalPaidJobFailureEvidence["events"]["funded"]
    finalised: ExternalPaidJobFailureEvidence["events"]["finalised"]
    refundTransfers: ExternalPaidJobFailureEvidence["events"]["refundTransfers"]
  }
}

export interface ExternalPaidJobLiveVerification {
  status: "LIVE_CHAIN_VERIFIED_FAILURE"
  jobId: string
  terminalStatus: "EXPIRED"
  receiptCount: number
  eventCount: number
  currentOwner: string
  observedAtUtc: string
  signatureMethod: "erc1271" | "eip191"
  historicalErc1271Recheck: "NOT_PERFORMED"
  historicalErc1271EvidenceStatus: "UNAVAILABLE" | "VERIFIED_AT_CAPTURE" | "NOT_APPLICABLE"
  historicalErc1271RecheckReason: "public RPC historical state pruned" | "historical verification is preserved as a point-in-time observation" | "EIP-191 signer recovery is independent of historical chain state"
}

export class ExternalPaidJobLiveEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExternalPaidJobLiveEvidenceError"
  }
}

export function verifyExternalPaidJobLiveObservation(
  candidate: unknown,
  observation: ExternalPaidJobLiveObservation,
): ExternalPaidJobLiveVerification {
  const evidence = verifyExternalPaidJobFailureEvidence(candidate)
  invariant(observation.chainId === evidence.network.chainId, "RPC chain does not match BSC testnet evidence")
  invariant(Number.isFinite(Date.parse(observation.observedAtUtc)), "live observation timestamp is invalid")
  verifyReceipts(evidence, observation)
  verifyCurrentState(evidence, observation)
  verifyEvents(evidence, observation)
  return {
    status: "LIVE_CHAIN_VERIFIED_FAILURE",
    jobId: evidence.lifecycle.jobId,
    terminalStatus: evidence.lifecycle.terminalStatus,
    receiptCount: externalPaidJobTransactionNames.length,
    eventCount: Object.values(observation.events).reduce((count, events) => count + events.length, 0),
    currentOwner: observation.owner,
    observedAtUtc: observation.observedAtUtc,
    signatureMethod: evidence.signature.method,
    historicalErc1271Recheck: "NOT_PERFORMED",
    historicalErc1271EvidenceStatus: evidence.signature.method === "eip191"
      ? "NOT_APPLICABLE"
      : evidence.signature.historicalRecheck,
    historicalErc1271RecheckReason: evidence.signature.method === "eip191"
      ? evidence.signature.historicalRecheckReason
      : evidence.signature.historicalRecheck === "UNAVAILABLE"
        ? evidence.signature.historicalRecheckReason
        : "historical verification is preserved as a point-in-time observation",
  }
}

function verifyReceipts(evidence: ExternalPaidJobFailureEvidence, observation: ExternalPaidJobLiveObservation): void {
  const targets: Record<ExternalPaidJobTransactionName, string> = {
    create: evidence.network.contracts.commerce,
    register: evidence.network.contracts.router,
    approve: evidence.network.contracts.paymentToken,
    setBudget: evidence.network.contracts.commerce,
    fund: evidence.network.contracts.commerce,
    refund: evidence.network.contracts.commerce,
    markExpired: evidence.network.contracts.router,
  }
  for (const name of externalPaidJobTransactionNames) {
    const recorded = evidence.transactions[name]
    const observed = observation.receipts[name]
    equalHex(observed.transactionHash, recorded.hash, `${name} receipt hash does not match evidence`)
    invariant(observed.status === recorded.status, `${name} receipt was not successful`)
    invariant(observed.blockNumber === recorded.blockNumber, `${name} receipt block does not match evidence`)
    equalHex(observed.blockHash, recorded.blockHash, `${name} receipt block hash does not match evidence`)
    invariant(observed.timestamp === recorded.timestamp, `${name} block timestamp does not match evidence`)
    invariant(observed.gasUsed === recorded.gasUsed, `${name} gas used does not match evidence`)
    invariant(observed.effectiveGasPriceWei === recorded.effectiveGasPriceWei, `${name} gas price does not match evidence`)
    invariant(observed.to !== null, `${name} receipt has no destination`)
    equalHex(observed.to, targets[name], `${name} transaction reached an unexpected contract`)
  }
}

function verifyCurrentState(evidence: ExternalPaidJobFailureEvidence, observation: ExternalPaidJobLiveObservation): void {
  const { job, lifecycle, identity, network } = { job: observation.job, lifecycle: evidence.lifecycle, identity: evidence.identity, network: evidence.network }
  equalHex(observation.owner, identity.provider, "current ERC-8004 owner does not match the provider")
  equalHex(observation.paymentToken, network.contracts.paymentToken, "current commerce payment token changed")
  equalHex(observation.jobPolicy, lifecycle.policy, "current router job policy does not match terminal evidence")
  invariant(job.id === lifecycle.jobId, "current job id does not match evidence")
  equalHex(job.client, lifecycle.client, "current job client changed")
  equalHex(job.provider, lifecycle.provider, "current job provider changed")
  equalHex(job.evaluator, lifecycle.evaluator, "current job evaluator changed")
  equalHex(job.hook, lifecycle.hook, "current job hook changed")
  invariant(job.description === evidence.onChainDescription, "current job description does not match the signed quote evidence")
  invariant(job.budget === lifecycle.budgetBaseUnits, "current job budget changed")
  invariant(job.expiredAt === lifecycle.expiredAt, "current job expiry changed")
  invariant(job.status === lifecycle.terminalStatusCode, "current job is not terminal EXPIRED")
  equalHex(job.deliverable, lifecycle.deliverableHash, "current job deliverable changed")
  invariant(job.submittedAt === lifecycle.submittedAt, "current job submittedAt changed")
}

function verifyEvents(evidence: ExternalPaidJobFailureEvidence, observation: ExternalPaidJobLiveObservation): void {
  for (const name of ["created", "registered", "funded", "finalised", "refundTransfers"] as const) {
    invariant(equivalent(observation.events[name], evidence.events[name]), `${name} live events do not match evidence`)
  }
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase()
  return value
}

function equalHex(left: string, right: string, message: string): void {
  invariant(left.toLowerCase() === right.toLowerCase(), message)
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ExternalPaidJobLiveEvidenceError(message)
}
