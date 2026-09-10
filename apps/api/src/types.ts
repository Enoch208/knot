import type { TaskSpec } from "../../../packages/contracts/src/task.ts"
import type { CommerceCompatibility } from "../../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../../packages/db/src/index.ts"
import type { ServiceRequestEnvelope } from "../../../packages/contracts/src/service-request.ts"
import type {
  FinancialState,
  ServiceRequestCreation,
  ServiceRequestRecord,
  VerifiedQuoteCreation,
  WorkState,
} from "../../../packages/db/src/index.ts"

export interface AccessScope {
  visibility: "PRIVATE"
}

export interface StoredTask {
  buyer: string
  task: TaskSpec
  accessScope: AccessScope
  createdAt: Date
}

export interface TaskCreation {
  task: StoredTask
  created: boolean
}

export interface JobArtifact {
  id: string
  mediaType: string
  byteHash: string
  storageUri: string
  visibility: "PRIVATE" | "SHARED" | "PUBLIC"
  retentionUntil: Date
  createdAt: Date
}

export interface JobTimelineEvent {
  id: string
  sequence: number
  eventType: string
  payload: Readonly<Record<string, unknown>>
  createdAt: Date
}

export interface StoredJob {
  id: string
  buyer: string
  taskId: string
  quoteId: string
  chainId: 56 | 97 | null
  commerce: string | null
  chainJobId: string | null
  workState: WorkState
  financialState: FinancialState
  protocolState: unknown
  version: number
  createdAt: Date
  updatedAt: Date
  artifacts: JobArtifact[]
  events: JobTimelineEvent[]
}

export interface ApiStore {
  status(): Promise<void>
  createTask(buyer: string, task: TaskSpec, accessScope: AccessScope): Promise<TaskCreation>
  getTask(taskId: string, buyer: string): Promise<StoredTask | null>
  createServiceRequest(input: {
    id: string
    buyer: string
    endpoint: string
    idempotencyKey: string
    envelope: ServiceRequestEnvelope
  }): Promise<ServiceRequestCreation>
  getServiceRequest(id: string, buyer: string): Promise<ServiceRequestRecord | null>
  createVerifiedQuote(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteCreation>
  getVerifiedQuote(id: string, buyer: string): Promise<VerifiedQuoteRecord | null>
  getJob(jobId: string, buyer: string): Promise<StoredJob | null>
}

export interface ApiConfig {
  commerceProbe?: () => Promise<CommerceCompatibility>
  authToken: string
  buyerAddress: string
  allowedOrigin: string
  maxBodyBytes: number
  now: () => Date
}

export interface ApiRequest {
  method: string
  path: string
  headers: Readonly<Record<string, string | undefined>>
  body: string | null
}

export interface ApiResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body: string
}
