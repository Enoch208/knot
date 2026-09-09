import type { Pool } from "pg"
import type { TaskSpec } from "../../../packages/contracts/src/task.ts"
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

  constructor(pool: Pool) {
    this.pool = pool
  }

  async status(): Promise<void> {
    const result = await this.pool.query<{ artifacts: string | null; jobs: string | null; tasks: string | null }>(
      "SELECT to_regclass('public.artifacts')::text AS artifacts, to_regclass('public.jobs')::text AS jobs, to_regclass('public.tasks')::text AS tasks",
    )
    const row = result.rows[0]
    if (!row?.artifacts || !row.jobs || !row.tasks) {
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

export class TaskConflictError extends Error {
  constructor() {
    super("task identifier is already bound to different intent")
    this.name = "TaskConflictError"
  }
}
