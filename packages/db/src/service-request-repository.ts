import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import {
  decodeServiceRequestTaskDescription,
  prepareServiceRequest,
  type PreparedServiceRequest,
  type ServiceRequestEnvelope,
  type ServiceRequestInputBinding,
} from "../../contracts/src/service-request.ts"
import { taskSpec, type TaskSpec } from "../../contracts/src/task.ts"
import { validateSafeUrl } from "../../security/src/index.ts"
import { IdempotencyConflictError, TaskDeadlineElapsedError } from "./errors.ts"

interface ServiceRequestRow {
  id: string
  buyer: string
  endpoint: string
  idempotency_key: string
  task_id: string
  task_spec_binding: unknown
  category: PreparedServiceRequest["category"]
  request_schema_version: PreparedServiceRequest["requestSchemaVersion"]
  transport: PreparedServiceRequest["transport"]
  request_bytes: Buffer
  request_sha256: `0x${string}`
  request_keccak256: `0x${string}`
  task_description: string
  task_description_sha256: `0x${string}`
  snapshot_id: string
  task_input_hash: `0x${string}`
  input_binding: ServiceRequestInputBinding
  created_at: Date
}

interface TaskDeadlineRow {
  deadline_at: Date
}

export interface ServiceRequestRecord {
  id: string
  buyer: `0x${string}`
  endpoint: string
  idempotencyKey: string
  taskId: string
  task: TaskSpec
  category: PreparedServiceRequest["category"]
  requestSchemaVersion: PreparedServiceRequest["requestSchemaVersion"]
  transport: PreparedServiceRequest["transport"]
  requestBytes: Buffer
  requestSha256: `0x${string}`
  requestKeccak256: `0x${string}`
  taskDescription: string
  taskDescriptionSha256: `0x${string}`
  snapshotId: string
  taskInputHash: `0x${string}`
  inputBinding: ServiceRequestInputBinding
  createdAt: Date
}

export interface CreateServiceRequestInput {
  id: string
  buyer: string
  endpoint: string
  idempotencyKey: string
  envelope: ServiceRequestEnvelope
}

export interface ServiceRequestCreation {
  record: ServiceRequestRecord
  created: boolean
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/

const validEndpoint = (value: string): boolean => {
  if (value.length > 2048) return false
  try {
    return validateSafeUrl(value).hash === ""
  } catch {
    return false
  }
}

const sha256 = (bytes: Uint8Array): `0x${string}` =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`

const mapServiceRequest = (row: ServiceRequestRow): ServiceRequestRecord => {
  const task = taskSpec.parse(row.task_spec_binding)
  let prepared: PreparedServiceRequest
  try {
    prepared = prepareServiceRequest(
      {
        schemaVersion: "knot.service-request/1",
        task,
        request: {
          mediaType: "application/json",
          schemaVersion: row.request_schema_version,
          bytesBase64url: row.request_bytes.toString("base64url"),
        },
        transport: row.transport,
      },
      row.buyer,
      { enforceTaskDescriptionLimit: false },
    )
  } catch {
    throw new Error("stored service request failed integrity validation")
  }
  return {
    id: row.id,
    buyer: row.buyer as `0x${string}`,
    endpoint: row.endpoint,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    task,
    category: row.category,
    requestSchemaVersion: row.request_schema_version,
    transport: row.transport,
    requestBytes: row.request_bytes,
    requestSha256: row.request_sha256,
    requestKeccak256: row.request_keccak256,
    taskDescription: row.task_description,
    taskDescriptionSha256: row.task_description_sha256,
    snapshotId: row.snapshot_id,
    taskInputHash: row.task_input_hash,
    inputBinding: row.input_binding,
    createdAt: row.created_at,
  }
}

const matches = (
  record: ServiceRequestRecord,
  input: CreateServiceRequestInput,
  prepared: PreparedServiceRequest,
): boolean =>
  record.id === input.id &&
  record.buyer === prepared.buyer &&
  record.endpoint === input.endpoint &&
  record.idempotencyKey === input.idempotencyKey &&
  record.taskId === prepared.taskId &&
  JSON.stringify(record.task) === JSON.stringify(prepared.task) &&
  record.category === prepared.category &&
  record.requestSchemaVersion === prepared.requestSchemaVersion &&
  record.transport === prepared.transport &&
  record.requestBytes.equals(Buffer.from(prepared.requestBytesBase64url, "base64url")) &&
  record.requestSha256 === prepared.requestSha256 &&
  record.requestKeccak256 === prepared.requestKeccak256 &&
  record.snapshotId === prepared.snapshotId &&
  record.taskInputHash === prepared.taskInputHash &&
  record.inputBinding === prepared.inputBinding

const assertStoredIntegrity = (record: ServiceRequestRecord): void => {
  let prepared: PreparedServiceRequest
  try {
    prepared = prepareServiceRequest(
      {
        schemaVersion: "knot.service-request/1",
        task: record.task,
        request: {
          mediaType: "application/json",
          schemaVersion: record.requestSchemaVersion,
          bytesBase64url: record.requestBytes.toString("base64url"),
        },
        transport: record.transport,
      },
      record.buyer,
      { enforceTaskDescriptionLimit: false },
    )
  } catch {
    throw new Error("stored service request failed integrity validation")
  }
  let describedRequestBytes: Buffer
  try {
    describedRequestBytes = decodeServiceRequestTaskDescription(record.taskDescription, record.transport)
  } catch {
    throw new Error("stored service request failed integrity validation")
  }
  if (
    record.requestSha256 !== sha256(record.requestBytes) ||
    record.taskDescriptionSha256 !== sha256(Buffer.from(record.taskDescription, "utf8")) ||
    !describedRequestBytes.equals(record.requestBytes) ||
    record.taskId !== prepared.taskId ||
    record.category !== prepared.category ||
    record.requestKeccak256 !== prepared.requestKeccak256 ||
    record.snapshotId !== prepared.snapshotId ||
    record.taskInputHash !== prepared.taskInputHash ||
    record.inputBinding !== prepared.inputBinding
  ) {
    throw new Error("stored service request failed integrity validation")
  }
}

export class ServiceRequestRepository {
  private readonly pool: Pick<Pool, "query">
  private readonly now: () => Date

  constructor(pool: Pool | PoolClient, now: () => Date = () => new Date()) {
    this.pool = pool
    this.now = now
  }

  async create(input: CreateServiceRequestInput): Promise<ServiceRequestCreation> {
    if (!identifier.test(input.id) || !identifier.test(input.idempotencyKey)) {
      throw new RangeError("service request identifiers are invalid")
    }
    if (!validEndpoint(input.endpoint)) throw new RangeError("service request endpoint is invalid")
    const prepared = prepareServiceRequest(input.envelope, input.buyer)
    const requestBytes = Buffer.from(prepared.requestBytesBase64url, "base64url")
    const requestedAt = this.now()
    const inserted = await this.pool.query<ServiceRequestRow>(
      "INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category, request_schema_version, transport, request_bytes, request_keccak256, task_description, task_description_sha256, snapshot_id, task_input_hash, input_binding) SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 FROM tasks WHERE id = $5 AND buyer = $2 AND category = $7 AND input_hash = $15 AND deadline_at > $17 ON CONFLICT (buyer, endpoint, idempotency_key) DO NOTHING RETURNING service_requests.*",
      [
        input.id,
        prepared.buyer,
        input.endpoint,
        input.idempotencyKey,
        prepared.taskId,
        JSON.stringify(prepared.task),
        prepared.category,
        prepared.requestSchemaVersion,
        prepared.transport,
        requestBytes,
        prepared.requestKeccak256,
        prepared.taskDescription,
        prepared.taskDescriptionSha256,
        prepared.snapshotId,
        prepared.taskInputHash,
        prepared.inputBinding,
        requestedAt,
      ],
    )
    if (inserted.rows[0]) {
      const record = mapServiceRequest(inserted.rows[0])
      assertStoredIntegrity(record)
      return { record, created: true }
    }
    const existing = await this.pool.query<ServiceRequestRow>(
      "SELECT * FROM service_requests WHERE buyer = $1 AND endpoint = $2 AND idempotency_key = $3",
      [prepared.buyer, input.endpoint, input.idempotencyKey],
    )
    const row = existing.rows[0]
    if (!row) {
      const task = await this.pool.query<TaskDeadlineRow>(
        "SELECT deadline_at FROM tasks WHERE id = $1 AND buyer = $2 AND category = $3 AND input_hash = $4",
        [prepared.taskId, prepared.buyer, prepared.category, prepared.taskInputHash],
      )
      const deadline = task.rows[0]?.deadline_at
      if (deadline && deadline.getTime() <= requestedAt.getTime()) {
        throw new TaskDeadlineElapsedError()
      }
      throw new IdempotencyConflictError()
    }
    const record = mapServiceRequest(row)
    assertStoredIntegrity(record)
    if (!matches(record, input, prepared)) throw new IdempotencyConflictError()
    return { record, created: false }
  }

  async get(id: string, buyer: string): Promise<ServiceRequestRecord | null> {
    const result = await this.pool.query<ServiceRequestRow>(
      "SELECT * FROM service_requests WHERE id = $1 AND buyer = lower($2)",
      [id, buyer],
    )
    const row = result.rows[0]
    if (!row) return null
    const record = mapServiceRequest(row)
    assertStoredIntegrity(record)
    return record
  }
}
