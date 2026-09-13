import type {
  FundingConfirmationState,
  HireJournal,
  PostFundingProgress,
  PublicHireStatus,
  PublicJobStatus,
  SellerNotificationState,
  WalletCall,
} from "./hire-types.ts"

const hashPattern = /^0x[0-9a-fA-F]{64}$/
const zeroHash = `0x${"0".repeat(64)}`
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const jobStatuses = new Set<PublicJobStatus>(["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED", "UNKNOWN"])
const verificationStates = new Set(["PENDING", "CONFIRMED", "REVERTED", "UNRESOLVED"])
const notificationStates = new Set<SellerNotificationState>(["NOT_SENT", "ACKNOWLEDGED", "RETRYABLE_TIMEOUT", "REJECTED"])

export interface FundingProof {
  creationTransactionHash: string
  fundingTransactionHashes: [string, string, string, string]
}

export interface LifecycleStep {
  label: "FUNDED" | "SUBMITTED" | "VERIFIED ARTIFACT" | "COMPLETED" | "REFUNDED"
  state: "waiting" | "current" | "complete" | "failed"
  detail: string
}

export interface LifecycleView {
  steps: LifecycleStep[]
  tone: "neutral" | "pending" | "success" | "warning" | "danger"
  title: string
  detail: string
  canCheck: boolean
  canRetryConfirmation: boolean
  refundCall: WalletCall | null
}

export function fundingProof(journal: HireJournal): FundingProof {
  if (journal.prepared.stage !== "FUND" || journal.progress.length !== 4 || !journal.progress.every(item => item.state === "confirmed")) {
    throw new Error("Every funding call must be confirmed before funding can be verified.")
  }
  if (!journal.creationHash || !hashPattern.test(journal.creationHash)) throw new Error("The verified creation hash is missing.")
  const hashes = journal.progress.map(item => item.transactionHash)
  if (hashes.some(hash => hash === null || !hashPattern.test(hash))) throw new Error("A verified funding hash is missing.")
  return {
    creationTransactionHash: journal.creationHash,
    fundingTransactionHashes: hashes as [string, string, string, string],
  }
}

export function parsePublicHireStatus(value: unknown, journal: HireJournal): PublicHireStatus {
  const record = asRecord(value)
  const proof = fundingProof(journal)
  const verification = asRecord(record.verification)
  const chain = asRecord(record.chain)
  const job = record.job === null ? null : asRecord(record.job)
  const lifecycle = asRecord(record.lifecycle)
  const notification = asRecord(record.sellerNotification)
  const deliverable = asRecord(record.deliverable)
  const refund = asRecord(record.refund)
  const fundingHashes = chain.fundingTransactionHashes
  const call = refund.call === null ? null : readWalletCall(refund.call)

  if (
    record.verifiedQuoteId !== journal.creation.verifiedQuoteId ||
    typeof record.buyer !== "string" || !addressPattern.test(record.buyer) || record.buyer.toLowerCase() !== journal.prepared.envelope.buyer.toLowerCase() ||
    !verificationStates.has(String(verification.state)) || !(verification.reason === null || typeof verification.reason === "string") ||
    !validJobIdentity(record.jobId, journal.prepared.envelope.jobId, String(verification.state)) ||
    chain.chainId !== 97 || chain.commerce !== journal.prepared.envelope.commerce || chain.creationTransactionHash !== proof.creationTransactionHash ||
    !Array.isArray(fundingHashes) || fundingHashes.length !== 4 || fundingHashes.some((hash, index) => hash !== proof.fundingTransactionHashes[index]) ||
    !(chain.confirmedAtBlock === null || (typeof chain.confirmedAtBlock === "string" && /^\d+$/.test(chain.confirmedAtBlock))) ||
    typeof chain.confirmations !== "number" || !Number.isInteger(chain.confirmations) || chain.confirmations < 0 ||
    !validJob(job, String(verification.state)) ||
    typeof lifecycle.workState !== "string" || typeof lifecycle.financialState !== "string" ||
    !notificationStates.has(notification.state as SellerNotificationState) ||
    !(notification.attemptedAtUtc === null || (typeof notification.attemptedAtUtc === "string" && Number.isFinite(Date.parse(notification.attemptedAtUtc)))) ||
    typeof notification.retryable !== "boolean" || typeof deliverable.available !== "boolean" ||
    !(deliverable.url === null || (typeof deliverable.url === "string" && /^https:\/\//.test(deliverable.url))) ||
    typeof refund.available !== "boolean" || !(refund.availableAtUnix === null || (typeof refund.availableAtUnix === "number" && Number.isSafeInteger(refund.availableAtUnix))) ||
    !(refund.reason === null || typeof refund.reason === "string") || refund.action !== "BUYER_WALLET_REQUIRED" ||
    (refund.available && call === null)
  ) throw new Error("The live hire status did not preserve the verified hire boundary.")

  return record as unknown as PublicHireStatus
}

export function lifecycleView(progress: PostFundingProgress | undefined): LifecycleView {
  const base = steps()
  if (!progress || progress.confirmationState === "idle" || progress.confirmationState === "signing") {
    return view(base, "neutral", "Verify confirmed funding", "Authorize a read-only proof so KNOT can match the five saved transaction hashes to canonical BSC testnet receipts.", true, true, null)
  }
  if (progress.confirmationState === "submitted" || progress.confirmationState === "pending") {
    return view(base, "pending", "Funding verification is pending", "The proof was accepted, but at least one receipt is not final yet. It is safe to check again; KNOT will not resubmit a transaction.", true, true, null)
  }
  if (progress.confirmationState === "conflict") {
    return view(base, "danger", "Funding proof was refused", "A receipt reverted or did not match the signed hire. No seller completion is claimed.", true, false, null)
  }
  if (progress.confirmationState === "unresolved" && !progress.lastStatus) {
    return view(base, "warning", "The last status request is unresolved", "The browser did not receive a conclusive response. Reload or check again using the same saved proof; no transaction will be sent.", true, true, null)
  }
  const status = progress.lastStatus
  if (!status) return view(base, "warning", "Status unavailable", "No verified lifecycle record is available yet.", true, true, null)

  if (status.verification.state === "PENDING" || status.verification.state === "UNRESOLVED") return view(base, "pending", "Funding verification is still resolving", status.verification.reason ?? "Check again after BSC testnet receipts become final.", true, true, null)
  if (status.verification.state === "REVERTED") return view(base, "danger", "A funding transaction reverted", status.verification.reason ?? "The hire did not reach verified funding.", true, false, null)
  if (!status.job) return view(base, "warning", "Canonical job state unavailable", "Funding cannot be presented as verified until the chain job is available.", true, true, null)

  const funded = status.job.status !== "OPEN" && status.job.status !== "UNKNOWN"
  const submitted = status.job.status === "SUBMITTED" || status.job.status === "COMPLETED"
  const artifactVerified = submitted && status.lifecycle.workState === "OUTPUT_CHECKED" && status.deliverable.available &&
    status.job.deliverableHash !== null && status.job.deliverableHash.toLowerCase() !== zeroHash
  const refunded = status.lifecycle.financialState === "REFUNDED"
  const completed = status.job.status === "COMPLETED" && status.lifecycle.financialState === "PAID" && artifactVerified
  mark(base, "FUNDED", funded)
  mark(base, "SUBMITTED", submitted)
  mark(base, "VERIFIED ARTIFACT", artifactVerified)
  mark(base, "COMPLETED", completed)
  mark(base, "REFUNDED", refunded)

  if (refunded) return view(base, "success", "Refund confirmed", "Canonical job state reports the buyer refund as complete.", true, false, null)
  if (completed) return view(base, "success", "Hire completed", "The submitted artifact was checked and canonical job state reports settlement as paid.", true, false, null)
  if (status.refund.available) {
    const refundStep = base.find(item => item.label === "REFUNDED")
    const defaultCurrent = base.find(item => item.state === "current")
    if (defaultCurrent) defaultCurrent.state = defaultCurrent.state === "complete" ? "complete" : "waiting"
    if (refundStep) refundStep.state = "current"
    return view(base, "warning", "Refund is available", status.refund.reason ?? "The seller deadline passed without a verified completion.", true, false, status.refund.call)
  }
  if (status.job.status === "REJECTED") return view(base, "danger", "Seller rejected the job", "The live record reports rejection. Check again for canonical refund availability.", true, false, null)
  if (status.job.status === "EXPIRED") return view(base, "warning", "Seller deadline expired", "The live record reports expiry. Refund is not shown until canonical state marks it available.", true, false, null)
  if (status.sellerNotification.state === "RETRYABLE_TIMEOUT") return view(base, "warning", "Seller acknowledgement timed out", "Funding remains verified. KNOT can retry notification without resending a buyer transaction.", true, false, null)
  if (status.sellerNotification.state === "REJECTED") return view(base, "danger", "Seller notification was rejected", "Funding remains verified, but seller work is not claimed. Check again for resolution or refund availability.", true, false, null)
  if (submitted && !artifactVerified) return view(base, "pending", "Artifact submitted; verification pending", "A submission is recorded, but KNOT has not marked its artifact hash as checked.", true, false, null)
  if (funded) return view(base, "pending", "Funding verified; seller work pending", "KNOT matched the saved receipts. Seller delivery and settlement are not claimed yet.", true, false, null)
  return view(base, "pending", "Waiting for verified funding", "The live record has not confirmed a funded job yet.", true, true, null)
}

const steps = (): LifecycleStep[] => [
  { label: "FUNDED", state: "current", detail: "Canonical receipts matched" },
  { label: "SUBMITTED", state: "waiting", detail: "Seller output recorded" },
  { label: "VERIFIED ARTIFACT", state: "waiting", detail: "Artifact hash checked" },
  { label: "COMPLETED", state: "waiting", detail: "Settlement paid" },
  { label: "REFUNDED", state: "waiting", detail: "Alternative terminal path" },
]

function mark(items: LifecycleStep[], label: LifecycleStep["label"], complete: boolean): void {
  const item = items.find(candidate => candidate.label === label)
  if (item && complete) item.state = "complete"
}

function view(stepsValue: LifecycleStep[], tone: LifecycleView["tone"], title: string, detail: string, canCheck: boolean, canRetryConfirmation: boolean, refundCall: WalletCall | null): LifecycleView {
  if (!["success", "danger"].includes(tone) && !stepsValue.some(item => item.state === "current")) {
    const firstWaiting = stepsValue.find(item => item.state === "waiting")
    if (firstWaiting) firstWaiting.state = "current"
  }
  return { steps: stepsValue, tone, title, detail, canCheck, canRetryConfirmation, refundCall }
}

function readWalletCall(value: unknown): WalletCall | null {
  const call = asRecord(value)
  return typeof call.to === "string" && addressPattern.test(call.to) && typeof call.data === "string" && /^0x[0-9a-fA-F]*$/.test(call.data) &&
    typeof call.value === "string" && /^\d+$/.test(call.value) ? { to: call.to, data: call.data, value: call.value } : null
}

function validJobIdentity(value: unknown, expected: string | null, verification: string): boolean {
  if (value === null) return verification !== "CONFIRMED"
  return typeof value === "string" && /^\d+$/.test(value) && value === expected
}

function validJob(value: Record<string, unknown> | null, verification: string): boolean {
  if (value === null) return verification !== "CONFIRMED"
  return jobStatuses.has(value.status as PublicJobStatus) &&
    typeof value.expiredAtUnix === "number" && Number.isSafeInteger(value.expiredAtUnix) &&
    (value.submittedAtUnix === null || (typeof value.submittedAtUnix === "number" && Number.isSafeInteger(value.submittedAtUnix))) &&
    (value.deliverableHash === null || (typeof value.deliverableHash === "string" && hashPattern.test(value.deliverableHash)))
}

const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
