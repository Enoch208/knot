import type { Pool } from "pg"
import { ConcurrentUpdateError, IdempotencyConflictError, LeaseRejectedError } from "./errors.ts"
import { appendJobEvent } from "./event-writer.ts"
import type { CreateJobInput, TransitionJobInput } from "./job-inputs.ts"
import { mapJob, type JobRow } from "./rows.ts"
import { assertFinancialTransition, assertWorkTransition } from "./state-machine.ts"
import { inTransaction } from "./transaction.ts"
import type { ClaimedJob, JobEvent, JobRecord, WorkerLease } from "./types.ts"

interface JobEventRow {
  id: string
  job_id: string
  sequence: number
  event_type: string
  payload: unknown
  created_at: Date
}

const claimedJob = (row: JobRow, workerId: string): ClaimedJob => {
  if (!row.lease_expires_at) throw new LeaseRejectedError()
  return {
    job: mapJob(row),
    lease: { jobId: row.id, workerId, fencingToken: row.fencing_token, expiresAt: row.lease_expires_at },
  }
}

const ensureIdempotentMatch = (job: JobRecord, input: CreateJobInput): JobRecord => {
  if (job.id !== input.id || job.taskId !== input.taskId || job.quoteId !== input.quoteId) {
    throw new IdempotencyConflictError()
  }
  return job
}

export class JobRepository {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const result = await this.pool.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [jobId])
    return result.rows[0] ? mapJob(result.rows[0]) : null
  }

  async events(jobId: string, afterSequence = 0): Promise<JobEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("event sequence must be a non-negative safe integer")
    }
    const result = await this.pool.query<JobEventRow>(
      "SELECT * FROM job_events WHERE job_id = $1 AND sequence > $2 ORDER BY sequence",
      [jobId, afterSequence],
    )
    return result.rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      sequence: row.sequence,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    }))
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query<JobRow>(
        "INSERT INTO jobs (id, buyer, endpoint, idempotency_key, task_id, quote_id, work_state, financial_state) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8) ON CONFLICT (buyer, endpoint, idempotency_key) DO NOTHING RETURNING *",
        [
          input.id,
          input.buyer,
          input.endpoint,
          input.idempotencyKey,
          input.taskId,
          input.quoteId,
          input.workState,
          input.financialState,
        ],
      )
      if (inserted.rows[0]) {
        await appendJobEvent(client, input.id, "job.created", {
          financialState: input.financialState,
          workState: input.workState,
        })
        return mapJob(inserted.rows[0])
      }
      const existing = await client.query<JobRow>(
        "SELECT * FROM jobs WHERE buyer = lower($1) AND endpoint = $2 AND idempotency_key = $3 FOR UPDATE",
        [input.buyer, input.endpoint, input.idempotencyKey],
      )
      const row = existing.rows[0]
      if (!row) {
        throw new ConcurrentUpdateError("job")
      }
      return ensureIdempotentMatch(mapJob(row), input)
    })
  }

  async claim(jobId: string, workerId: string, leaseMilliseconds: number): Promise<ClaimedJob | null> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError("lease duration must be a positive safe integer")
    }
    const result = await this.pool.query<JobRow>(
      "UPDATE jobs SET lease_owner = $2, lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'), fencing_token = fencing_token + 1, version = version + 1 WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()) RETURNING *",
      [jobId, workerId, leaseMilliseconds],
    )
    const row = result.rows[0]
    return row ? claimedJob(row, workerId) : null
  }

  async claimChainActionRecovery(workerId: string, leaseMilliseconds: number): Promise<ClaimedJob | null> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError("lease duration must be a positive safe integer")
    }
    const result = await this.pool.query<JobRow>(
      "WITH available AS (SELECT jobs.id FROM jobs WHERE (jobs.lease_expires_at IS NULL OR jobs.lease_expires_at <= clock_timestamp()) AND EXISTS (SELECT 1 FROM chain_actions WHERE chain_actions.job_id = jobs.id AND chain_actions.state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND chain_actions.nonce IS NOT NULL AND chain_actions.relay_intent_id IS NULL AND chain_actions.transaction_intent IS NOT NULL AND (chain_actions.state <> 'SUBMITTED' OR chain_actions.transaction_hash IS NOT NULL)) ORDER BY greatest((SELECT min(chain_actions.updated_at) FROM chain_actions WHERE chain_actions.job_id = jobs.id AND chain_actions.state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND chain_actions.nonce IS NOT NULL AND chain_actions.relay_intent_id IS NULL AND chain_actions.transaction_intent IS NOT NULL AND (chain_actions.state <> 'SUBMITTED' OR chain_actions.transaction_hash IS NOT NULL)), jobs.updated_at), jobs.id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs AS target SET lease_owner = $1, lease_expires_at = clock_timestamp() + ($2 * interval '1 millisecond'), fencing_token = target.fencing_token + 1, version = target.version + 1 FROM available WHERE target.id = available.id RETURNING target.*",
      [workerId, leaseMilliseconds],
    )
    const row = result.rows[0]
    return row ? claimedJob(row, workerId) : null
  }

  async releaseLease(lease: WorkerLease): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL, version = version + 1 WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 RETURNING id",
      [lease.jobId, lease.workerId, lease.fencingToken],
    )
    return result.rowCount === 1
  }

  async releaseChainActionRecovery(lease: WorkerLease): Promise<boolean> {
    return this.releaseLease(lease)
  }

  async renew(
    lease: WorkerLease,
    expectedVersion: number,
    leaseMilliseconds: number,
  ): Promise<ClaimedJob> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError("lease duration must be a positive safe integer")
    }
    const result = await this.pool.query<JobRow>(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'), version = version + 1 WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND version = $4 AND lease_expires_at > clock_timestamp() RETURNING *",
      [lease.jobId, lease.workerId, lease.fencingToken, expectedVersion, leaseMilliseconds],
    )
    const row = result.rows[0]
    if (!row || !row.lease_expires_at) {
      throw new LeaseRejectedError()
    }
    return {
      job: mapJob(row),
      lease: { ...lease, expiresAt: row.lease_expires_at },
    }
  }

  async transition(input: TransitionJobInput): Promise<JobRecord> {
    return inTransaction(this.pool, async (client) => {
      const currentResult = await client.query<JobRow>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [
        input.jobId,
      ])
      const currentRow = currentResult.rows[0]
      if (!currentRow) {
        throw new ConcurrentUpdateError("job")
      }
      const current = mapJob(currentRow)
      if (
        current.version !== input.expectedVersion ||
        current.leaseOwner !== input.lease.workerId ||
        current.fencingToken !== input.lease.fencingToken ||
        !current.leaseExpiresAt
      ) {
        throw new LeaseRejectedError()
      }
      assertWorkTransition(current.workState, input.workState)
      assertFinancialTransition(current.financialState, input.financialState)
      if (
        input.chainBinding &&
        current.chainId !== null &&
        (current.chainId !== input.chainBinding.chainId ||
          current.commerce !== input.chainBinding.commerce.toLowerCase() ||
          current.chainJobId !== input.chainBinding.chainJobId)
      ) {
        throw new IdempotencyConflictError()
      }
      const updated = await client.query<JobRow>(
        "UPDATE jobs SET work_state = $2, financial_state = $3, protocol_state = $4::jsonb, version = version + 1, chain_id = COALESCE(chain_id, $8::integer), commerce = COALESCE(commerce, lower($9)), chain_job_id = COALESCE(chain_job_id, $10::numeric) WHERE id = $1 AND version = $5 AND lease_owner = $6 AND fencing_token = $7 AND lease_expires_at > clock_timestamp() RETURNING *",
        [
          input.jobId,
          input.workState,
          input.financialState,
          JSON.stringify(input.protocolState),
          input.expectedVersion,
          input.lease.workerId,
          input.lease.fencingToken,
          input.chainBinding?.chainId ?? null,
          input.chainBinding?.commerce ?? null,
          input.chainBinding?.chainJobId ?? null,
        ],
      )
      const row = updated.rows[0]
      if (!row) {
        throw new LeaseRejectedError()
      }
      await appendJobEvent(client, input.jobId, input.eventType, input.eventPayload)
      return mapJob(row)
    })
  }
}
