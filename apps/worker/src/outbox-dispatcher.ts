import type { OutboxLease } from "../../../packages/db/src/outbox-repository.ts"

export interface OutboxLeaseRepository {
  claim(workerId: string, limit: number, leaseMilliseconds: number): Promise<OutboxLease[]>
  markPublished(id: string, workerId: string, fencingToken: string): Promise<void>
  releaseLease(lease: OutboxLease): Promise<boolean>
}

export type EventPublisher = (event: OutboxLease, signal?: AbortSignal) => Promise<void>

export class OutboxDispatcher {
  private readonly workerId: string
  private readonly leaseMilliseconds: number
  private readonly outbox: OutboxLeaseRepository
  private readonly publish: EventPublisher

  constructor(
    workerId: string,
    leaseMilliseconds: number,
    outbox: OutboxLeaseRepository,
    publish: EventPublisher,
  ) {
    if (workerId.trim() === "") throw new Error("worker id is required")
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) throw new RangeError("lease duration must be a positive safe integer")
    this.workerId = workerId
    this.leaseMilliseconds = leaseMilliseconds
    this.outbox = outbox
    this.publish = publish
  }

  async dispatch(limit = 25, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("outbox claim limit must be between 1 and 100")
    signal?.throwIfAborted()
    const events = await this.outbox.claim(this.workerId, limit, this.leaseMilliseconds)
    let published = 0
    try {
      for (const event of events) {
        signal?.throwIfAborted()
        await this.publish(event, signal)
        await this.outbox.markPublished(event.id, this.workerId, event.fencingToken)
        published += 1
      }
      return published
    } catch (error) {
      const releaseErrors: unknown[] = []
      for (const event of events.slice(published)) {
        try {
          await this.outbox.releaseLease(event)
        } catch (releaseError) {
          releaseErrors.push(releaseError)
        }
      }
      if (releaseErrors.length > 0) throw new AggregateError([error, ...releaseErrors], "outbox dispatch and lease release failed")
      throw error
    }
  }
}
