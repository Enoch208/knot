export interface HireEnvelope {
  chainId: 97
  jobId: string | null
  buyer: string
  provider: string
  descriptionSha256Source: string
  budgetBaseUnits: string
  paymentToken: string
  commerce: string
  policy: string
  disputeWindowSeconds: number
  expiredAtUnix: number
  quoteExpiresAtUnix: number
  callCount: number
}

export interface WalletCall { to: string; data: string; value: string }
export interface PreparedHire {
  stage: "CREATE" | "FUND"
  verifiedQuoteId: string
  envelope: HireEnvelope
  calls: readonly WalletCall[]
}
export interface ReceiptLog { address: string; data: string; topics: readonly string[] }
export interface ConfirmedReceipt {
  status: "success" | "reverted"
  transactionHash: string
  blockNumber: string
  logs: readonly ReceiptLog[]
  transaction: { from: string; to: string | null; input: string; value: string; chainId: number }
}
export type CallState = "waiting" | "signing" | "submitted" | "confirmed" | "reverted" | "unresolved" | "not attempted"
export interface CallProgress { state: CallState; transactionHash: string | null }

export type FundingConfirmationState = "idle" | "signing" | "submitted" | "pending" | "confirmed" | "conflict" | "unresolved"
export type HireVerificationState = "PENDING" | "CONFIRMED" | "REVERTED" | "UNRESOLVED"
export type PublicJobStatus = "OPEN" | "FUNDED" | "SUBMITTED" | "COMPLETED" | "REJECTED" | "EXPIRED" | "UNKNOWN"
export type SellerNotificationState = "NOT_SENT" | "ACKNOWLEDGED" | "RETRYABLE_TIMEOUT" | "REJECTED"

export interface PublicHireStatus {
  verifiedQuoteId: string
  buyer: string
  jobId: string | null
  verification: { state: HireVerificationState; reason: string | null }
  chain: {
    chainId: 97
    commerce: string
    creationTransactionHash: string
    fundingTransactionHashes: [string, string, string, string]
    confirmedAtBlock: string | null
    confirmations: number
  }
  job: {
    status: PublicJobStatus
    expiredAtUnix: number
    submittedAtUnix: number | null
    deliverableHash: string | null
  } | null
  lifecycle: { workState: string; financialState: string }
  sellerNotification: {
    state: SellerNotificationState
    attemptedAtUtc: string | null
    retryable: boolean
  }
  deliverable: { available: boolean; url: string | null }
  refund: {
    available: boolean
    availableAtUnix: number | null
    reason: string | null
    action: "BUYER_WALLET_REQUIRED"
    call: WalletCall | null
  }
}

export interface PostFundingProgress {
  confirmationState: FundingConfirmationState
  lastStatus: PublicHireStatus | null
  checkedAtUtc: string | null
  fundingProof?: { intent: string; signature: string }
  statusProof?: { intent: string; signature: string }
}

export interface HireJournal {
  version: 1
  creation: PreparedHire
  prepared: PreparedHire
  progress: CallProgress[]
  creationHash: string | null
  postFunding?: PostFundingProgress
}
