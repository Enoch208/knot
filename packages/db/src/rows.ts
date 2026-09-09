import type { JobRecord, OutboxRecord } from "./types.ts"

export interface JobRow {
  id: string
  buyer: string
  endpoint: string
  idempotency_key: string
  task_id: string
  quote_id: string
  chain_id: 56 | 97 | null
  commerce: string | null
  chain_job_id: string | null
  work_state: JobRecord["workState"]
  financial_state: JobRecord["financialState"]
  protocol_state: unknown
  version: number
  fencing_token: string
  lease_owner: string | null
  lease_expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface OutboxRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  aggregate_sequence: number
  event_type: string
  payload: unknown
  attempts: number
  fencing_token: string
  lease_owner: string | null
  lease_expires_at: Date | null
  published_at: Date | null
  created_at: Date
}

export const mapJob = (row: JobRow): JobRecord => ({
  id: row.id,
  buyer: row.buyer,
  endpoint: row.endpoint,
  idempotencyKey: row.idempotency_key,
  taskId: row.task_id,
  quoteId: row.quote_id,
  chainId: row.chain_id,
  commerce: row.commerce,
  chainJobId: row.chain_job_id,
  workState: row.work_state,
  financialState: row.financial_state,
  protocolState: row.protocol_state,
  version: row.version,
  fencingToken: row.fencing_token,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const mapOutbox = (row: OutboxRow): OutboxRecord => ({
  id: row.id,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  aggregateSequence: row.aggregate_sequence,
  eventType: row.event_type,
  payload: row.payload,
  attempts: row.attempts,
  fencingToken: row.fencing_token,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  publishedAt: row.published_at,
  createdAt: row.created_at,
})
