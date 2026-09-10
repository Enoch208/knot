import type { Pool } from "pg"
import type { ServiceRequestEnvelope } from "../../../packages/contracts/src/service-request.ts"
import type { TaskSpec } from "../../../packages/contracts/src/task.ts"
import {
  ServiceRequestRepository,
  VerifiedQuoteRepository,
  type ServiceRequestCreation,
  type ServiceRequestRecord,
  type VerifiedQuoteCreation,
  type VerifiedQuoteRecord,
} from "../../../packages/db/src/index.ts"
import { mapArtifact, mapEvent, mapJob, mapTask } from "./db-mappers.ts"
import type {
  AccessScope,
  ApiStore,
  StoredJob,
  StoredTask,
  TaskCreation,
} from "./types.ts"

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new TypeError("value is not JSON serializable")
  }
  return encoded
}

export class PgApiStore implements ApiStore {
  private readonly pool: Pool
  private readonly serviceRequests: ServiceRequestRepository
  private readonly verifiedQuotes: VerifiedQuoteRepository
  private readonly verifiedQuoteCreator: VerifiedQuoteCreator | null

  constructor(pool: Pool, verifiedQuoteCreator: VerifiedQuoteCreator | null = null) {
    this.pool = pool
    this.serviceRequests = new ServiceRequestRepository(pool)
    this.verifiedQuotes = new VerifiedQuoteRepository(pool)
    this.verifiedQuoteCreator = verifiedQuoteCreator
  }

  async status(): Promise<void> {
    const result = await this.pool.query<{
      artifacts: string | null
      identity_observations: string | null
      identity_observation_column: boolean
      jobs: string | null
      migration_0011: boolean
      migration_0012: boolean
      service_requests: string | null
      tasks: string | null
      verified_quotes: string | null
    }>(
      "SELECT to_regclass('public.artifacts')::text AS artifacts, to_regclass('public.erc8004_identity_observations')::text AS identity_observations, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'verified_quotes' AND column_name = 'identity_observation_id') AS identity_observation_column, to_regclass('public.jobs')::text AS jobs, EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0011_erc8004_identity_observations.sql') AS migration_0011, EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0012_verified_quote_identity_observation.sql') AS migration_0012, to_regclass('public.service_requests')::text AS service_requests, to_regclass('public.tasks')::text AS tasks, to_regclass('public.verified_quotes')::text AS verified_quotes",
    )
    const row = result.rows[0]
    if (
      !row?.artifacts ||
      !row.identity_observations ||
      !row.identity_observation_column ||
      !row.jobs ||
      !row.migration_0011 ||
      !row.migration_0012 ||
      !row.service_requests ||
      !row.tasks ||
      !row.verified_quotes
    ) {
      throw new Error("required database schema is unavailable")
    }
  }

  async createTask(
    buyer: string,
    task: TaskSpec,
    scope: AccessScope,
  ): Promise<TaskCreation> {
    const inserted = await this.pool.query(
      "INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, execution_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13) ON CONFLICT (id) DO NOTHING RETURNING buyer, task_spec, access_scope, created_at",
      [
        task.taskId,
        buyer,
        task.schemaVersion,
        task.category,
        task.capability,
        task.identityChainId,
        task.dataChainId,
        task.paymentChainId,
        task.executionChainId,
        task.inputHash,
        JSON.stringify(task),
        JSON.stringify(scope),
        task.deadlineUtc,
      ],
    )
    const createdRow = inserted.rows[0] as unknown
    if (createdRow) {
      return { task: mapTask(createdRow), created: true }
    }
    const existing = await this.getTaskRecord(task.taskId)
    if (
      existing &&
      existing.buyer === buyer.toLowerCase() &&
      canonicalJson(existing.task) === canonicalJson(task) &&
      canonicalJson(existing.accessScope) === canonicalJson(scope)
    ) {
      return { task: existing, created: false }
    }
    throw new TaskConflictError()
  }

  async getTask(taskId: string, buyer: string): Promise<StoredTask | null> {
    const task = await this.getTaskRecord(taskId)
    return task?.buyer === buyer.toLowerCase() ? task : null
  }

  async createServiceRequest(input: {
    id: string
    buyer: string
    endpoint: string
    idempotencyKey: string
    envelope: ServiceRequestEnvelope
  }): Promise<ServiceRequestCreation> {
    return this.serviceRequests.create(input)
  }

  async getServiceRequest(id: string, buyer: string): Promise<ServiceRequestRecord | null> {
    return this.serviceRequests.get(id, buyer)
  }

  async createVerifiedQuote(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteCreation> {
    if (this.verifiedQuoteCreator === null) throw new VerifiedQuoteCreationUnavailableError()
    return this.verifiedQuoteCreator.create(serviceRequestId, buyer)
  }

  async getVerifiedQuote(id: string, buyer: string): Promise<VerifiedQuoteRecord | null> {
    return this.verifiedQuotes.get(id, buyer)
  }

  async getJob(jobId: string, buyer: string): Promise<StoredJob | null> {
    const result = await this.pool.query("SELECT id, buyer, task_id, quote_id, chain_id, commerce, chain_job_id, work_state, financial_state, protocol_state, version, created_at, updated_at FROM jobs WHERE id = $1 AND buyer = lower($2)", [jobId, buyer])
    const value = result.rows[0] as unknown
    if (!value) {
      return null
    }
    const row = mapJob(value)
    const artifacts = await this.pool.query("SELECT id, media_type, byte_hash, storage_uri, visibility, retention_until, created_at FROM artifacts WHERE job_id = $1 ORDER BY created_at, id", [jobId])
    const events = await this.pool.query("SELECT id, sequence, event_type, payload, created_at FROM job_events WHERE job_id = $1 ORDER BY sequence", [jobId])
    return {
      ...row,
      artifacts: artifacts.rows.map((artifact) => mapArtifact(artifact as unknown)),
      events: events.rows.map((event) => mapEvent(event as unknown)),
    }
  }

  private async getTaskRecord(taskId: string): Promise<StoredTask | null> {
    const result = await this.pool.query(
      "SELECT buyer, task_spec, access_scope, created_at FROM tasks WHERE id = $1",
      [taskId],
    )
    const value = result.rows[0] as unknown
    return value ? mapTask(value) : null
  }
}

export interface VerifiedQuoteCreator {
  create(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteCreation>
}

export class VerifiedQuoteCreationUnavailableError extends Error {
  constructor() {
    super("owned seller quote orchestration is unavailable")
    this.name = "VerifiedQuoteCreationUnavailableError"
  }
}

export class TaskConflictError extends Error {
  constructor() {
    super("task identifier is already bound to different intent")
    this.name = "TaskConflictError"
  }
}
