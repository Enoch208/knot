export const WORK_STATES = [
  "DRAFT",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAYMENT_OBSERVED",
  "RUNNING",
  "OUTPUT_RECEIVED",
  "OUTPUT_CHECKED",
  "FAILED",
  "EXPIRED",
  "CANCELED",
] as const

export const FINANCIAL_STATES = [
  "UNFUNDED",
  "FUNDING_PENDING",
  "ESCROWED",
  "RESOLUTION_PENDING",
  "PAID",
  "REFUNDED",
  "UNKNOWN",
] as const

export const CHAIN_ACTION_STATES = [
  "PREPARED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "UNKNOWN",
] as const

export type WorkState = (typeof WORK_STATES)[number]
export type FinancialState = (typeof FINANCIAL_STATES)[number]
export type ChainActionState = (typeof CHAIN_ACTION_STATES)[number]

export interface JobRecord {
  id: string
  buyer: string
  endpoint: string
  idempotencyKey: string
  taskId: string
  quoteId: string
  chainId: 56 | 97 | null
  commerce: string | null
  chainJobId: string | null
  workState: WorkState
  financialState: FinancialState
  protocolState: unknown
  version: number
  fencingToken: string
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface WorkerLease {
  jobId: string
  workerId: string
  fencingToken: string
  expiresAt: Date
}

export interface ClaimedJob {
  job: JobRecord
  lease: WorkerLease
}

export interface JobEvent {
  id: string
  jobId: string
  sequence: number
  eventType: string
  payload: unknown
  createdAt: Date
}

export interface OutboxRecord {
  id: string
  aggregateType: string
  aggregateId: string
  aggregateSequence: number
  eventType: string
  payload: unknown
  attempts: number
  fencingToken: string
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  publishedAt: Date | null
  createdAt: Date
}
