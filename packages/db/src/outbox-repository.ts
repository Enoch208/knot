import type { Pool } from "pg"
import { LeaseRejectedError } from "./errors.ts"
import { mapOutbox, type OutboxRow } from "./rows.ts"
import type { OutboxRecord } from "./types.ts"

export interface OutboxLease extends OutboxRecord {
  leaseOwner: string
  leaseExpiresAt: Date
}

export class OutboxRepository {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async claim(workerId: string, limit: number, leaseMilliseconds: number): Promise<OutboxLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("outbox claim limit must be between 1 and 100")
    }
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError("lease duration must be a positive safe integer")
    }
    const result = await this.pool.query<OutboxRow>(
      "WITH available AS (SELECT id FROM outbox WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE outbox AS target SET lease_owner = $1, lease_expires_at = now() + ($3 * interval '1 millisecond'), fencing_token = target.fencing_token + 1, attempts = target.attempts + 1 FROM available WHERE target.id = available.id RETURNING target.*",
      [workerId, limit, leaseMilliseconds],
    )
    return result.rows.map((row) => mapOutbox(row)).filter((record): record is OutboxLease => {
      return record.leaseOwner !== null && record.leaseExpiresAt !== null
    })
  }

  async markPublished(id: string, workerId: string, fencingToken: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE outbox SET published_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND lease_expires_at > now() AND published_at IS NULL",
      [id, workerId, fencingToken],
    )
    if (result.rowCount !== 1) {
      throw new LeaseRejectedError()
    }
  }

  async releaseLease(lease: OutboxLease): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE outbox SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3 AND published_at IS NULL RETURNING id",
      [lease.id, lease.leaseOwner, lease.fencingToken],
    )
    return result.rowCount === 1
  }
}
