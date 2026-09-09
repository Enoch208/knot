import type { FinancialState, WorkerLease, WorkState } from "./types.ts"

export interface CreateJobInput {
  id: string
  buyer: string
  endpoint: string
  idempotencyKey: string
  taskId: string
  quoteId: string
  workState: WorkState
  financialState: FinancialState
}

export interface TransitionJobInput {
  jobId: string
  expectedVersion: number
  lease: WorkerLease
  workState: WorkState
  financialState: FinancialState
  protocolState: Readonly<Record<string, unknown>>
  eventType: string
  eventPayload: Readonly<Record<string, unknown>>
  chainBinding?: {
    chainId: 56 | 97
    commerce: string
    chainJobId: string
  }
}
