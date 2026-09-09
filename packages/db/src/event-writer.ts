import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { ConcurrentUpdateError } from "./errors.ts"

export const appendJobEvent = async (
  client: PoolClient,
  jobId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const sequenceResult = await client.query<{ sequence: number }>(
    "SELECT COALESCE(max(sequence), 0)::integer + 1 AS sequence FROM job_events WHERE job_id = $1",
    [jobId],
  )
  const sequence = sequenceResult.rows[0]?.sequence
  if (!sequence) {
    throw new ConcurrentUpdateError("job event")
  }
  const eventId = randomUUID()
  await client.query(
    "INSERT INTO job_events (id, job_id, sequence, event_type, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [eventId, jobId, sequence, eventType, JSON.stringify(payload)],
  )
  await client.query(
    "INSERT INTO outbox (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload) VALUES ($1, 'job', $2, $3, $4, $5::jsonb)",
    [eventId, jobId, sequence, eventType, JSON.stringify(payload)],
  )
}
