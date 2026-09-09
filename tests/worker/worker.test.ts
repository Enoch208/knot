import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { JobWorker } from "../../apps/worker/src/job-worker.ts"
import { OutboxDispatcher } from "../../apps/worker/src/outbox-dispatcher.ts"
import type {
  ClaimedJob,
  JobRepository,
  OutboxRecord,
  OutboxRepository,
} from "../../packages/db/src/index.ts"
import type { OutboxLease } from "../../packages/db/src/outbox-repository.ts"

const claim: ClaimedJob = {
  job: {
    id: "job-1",
    buyer: "0x1111111111111111111111111111111111111111",
    endpoint: "/api/jobs",
    idempotencyKey: "request-1",
    taskId: "task-1",
    quoteId: "quote-1",
    chainId: null,
    commerce: null,
    chainJobId: null,
    workState: "DRAFT",
    financialState: "UNFUNDED",
    protocolState: {},
    version: 1,
    fencingToken: "1",
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  lease: {
    jobId: "job-1",
    workerId: "worker-1",
    fencingToken: "1",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  },
}

const event: OutboxLease = {
  id: "event-1",
  aggregateType: "job",
  aggregateId: "job-1",
  aggregateSequence: 1,
  eventType: "job.created",
  payload: {},
  attempts: 1,
  fencingToken: "2",
  leaseOwner: "publisher-1",
  leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
  publishedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
}

describe("worker lease consumers", () => {
  it("does not invoke a handler when the durable job lease is unavailable", async () => {
    let invoked = false
    const repository = {
      claim: async () => null,
    } as unknown as JobRepository
    const worker = new JobWorker("worker-1", 1_000, repository, async () => {
      invoked = true
    })
    assert.equal(await worker.process("job-1"), false)
    assert.equal(invoked, false)
  })

  it("passes the exact claimed fencing token to the job handler", async () => {
    let observed: ClaimedJob | null = null
    const repository = {
      claim: async () => claim,
    } as unknown as JobRepository
    const worker = new JobWorker("worker-1", 1_000, repository, async (leased) => {
      observed = leased
    })
    assert.equal(await worker.process("job-1"), true)
    assert.equal((observed as ClaimedJob | null)?.lease.fencingToken, "1")
  })

  it("acknowledges an outbox record only after publishing succeeds", async () => {
    const calls: string[] = []
    const repository = {
      claim: async (): Promise<OutboxLease[]> => [event],
      markPublished: async (): Promise<void> => {
        calls.push("acknowledged")
      },
    } as unknown as OutboxRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, repository, async () => {
      calls.push("published")
    })
    assert.equal(await dispatcher.dispatch(), 1)
    assert.deepEqual(calls, ["published", "acknowledged"])
  })

  it("leaves the event unacknowledged when publishing fails", async () => {
    let acknowledged = false
    const repository = {
      claim: async (): Promise<OutboxRecord[]> => [event],
      markPublished: async (): Promise<void> => {
        acknowledged = true
      },
    } as unknown as OutboxRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, repository, async () => {
      throw new Error("publisher unavailable")
    })
    await assert.rejects(() => dispatcher.dispatch(), /publisher unavailable/)
    assert.equal(acknowledged, false)
  })
})
