import type { OutboxRepository } from "../../../packages/db/src/index.ts"
import type { OutboxLease } from "../../../packages/db/src/outbox-repository.ts"

export type EventPublisher = (event: OutboxLease) => Promise<void>

export class OutboxDispatcher {
  private readonly workerId: string
  private readonly leaseMilliseconds: number
  private readonly outbox: OutboxRepository
  private readonly publish: EventPublisher

  constructor(
    workerId: string,
    leaseMilliseconds: number,
    outbox: OutboxRepository,
    publish: EventPublisher,
  ) {
    this.workerId = workerId
    this.leaseMilliseconds = leaseMilliseconds
    this.outbox = outbox
    this.publish = publish
  }

  async dispatch(limit = 25): Promise<number> {
    const events = await this.outbox.claim(this.workerId, limit, this.leaseMilliseconds)
    let published = 0
    for (const event of events) {
      await this.publish(event)
      await this.outbox.markPublished(event.id, this.workerId, event.fencingToken)
      published += 1
    }
    return published
  }
}
