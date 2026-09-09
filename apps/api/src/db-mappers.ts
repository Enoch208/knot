import { z } from "zod"
import { taskSpec } from "../../../packages/contracts/src/task.ts"
import { FINANCIAL_STATES, WORK_STATES } from "../../../packages/db/src/types.ts"
import { accessScope } from "./schemas.ts"
import type { JobArtifact, JobTimelineEvent, StoredJob, StoredTask } from "./types.ts"

const taskRow = z.object({
  buyer: z.string(),
  task_spec: z.unknown(),
  access_scope: z.unknown(),
  created_at: z.date(),
})

const jobRow = z.object({
  id: z.string(),
  buyer: z.string(),
  task_id: z.string(),
  quote_id: z.string(),
  chain_id: z.union([z.literal(56), z.literal(97)]).nullable(),
  commerce: z.string().nullable(),
  chain_job_id: z.string().nullable(),
  work_state: z.enum(WORK_STATES),
  financial_state: z.enum(FINANCIAL_STATES),
  protocol_state: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  created_at: z.date(),
  updated_at: z.date(),
})

const artifactRow = z.object({
  id: z.string(),
  media_type: z.string(),
  byte_hash: z.string(),
  storage_uri: z.string(),
  visibility: z.enum(["PRIVATE", "SHARED", "PUBLIC"]),
  retention_until: z.date(),
  created_at: z.date(),
})

const eventRow = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.date(),
})

export const mapTask = (value: unknown): StoredTask => {
  const row = taskRow.parse(value)
  return {
    buyer: row.buyer,
    task: taskSpec.parse(row.task_spec),
    accessScope: accessScope.parse(row.access_scope),
    createdAt: row.created_at,
  }
}

export const mapJob = (value: unknown): Omit<StoredJob, "artifacts" | "events"> => {
  const row = jobRow.parse(value)
  return {
    id: row.id,
    buyer: row.buyer,
    taskId: row.task_id,
    quoteId: row.quote_id,
    chainId: row.chain_id,
    commerce: row.commerce,
    chainJobId: row.chain_job_id,
    workState: row.work_state,
    financialState: row.financial_state,
    protocolState: row.protocol_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const mapArtifact = (value: unknown): JobArtifact => {
  const row = artifactRow.parse(value)
  return {
    id: row.id,
    mediaType: row.media_type,
    byteHash: row.byte_hash,
    storageUri: row.storage_uri,
    visibility: row.visibility,
    retentionUntil: row.retention_until,
    createdAt: row.created_at,
  }
}

export const mapEvent = (value: unknown): JobTimelineEvent => {
  const row = eventRow.parse(value)
  return {
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  }
}
