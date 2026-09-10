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
export interface HireJournal {
  version: 1
  creation: PreparedHire
  prepared: PreparedHire
  progress: CallProgress[]
  creationHash: string | null
}
