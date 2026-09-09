import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { JobWorker, type JobLeaseRepository } from "../../apps/worker/src/job-worker.ts"
import { OutboxDispatcher, type OutboxLeaseRepository } from "../../apps/worker/src/outbox-dispatcher.ts"
import type { ClaimedJob } from "../../packages/db/src/index.ts"
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
      releaseLease: async () => false,
    } satisfies JobLeaseRepository
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
      releaseLease: async () => false,
    } satisfies JobLeaseRepository
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
      releaseLease: async (): Promise<boolean> => true,
    } satisfies OutboxLeaseRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, repository, async () => {
      calls.push("published")
    })
    assert.equal(await dispatcher.dispatch(), 1)
    assert.deepEqual(calls, ["published", "acknowledged"])
  })

  it("leaves the event unacknowledged when publishing fails", async () => {
    let acknowledged = false
    let released: OutboxLease | null = null
    const repository = {
      claim: async (): Promise<OutboxLease[]> => [event],
      markPublished: async (): Promise<void> => {
        acknowledged = true
      },
      releaseLease: async (lease: OutboxLease): Promise<boolean> => {
        released = lease
        return true
      },
    } satisfies OutboxLeaseRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, repository, async () => {
      throw new Error("publisher unavailable")
    })
    await assert.rejects(() => dispatcher.dispatch(), /publisher unavailable/)
    assert.equal(acknowledged, false)
    assert.equal(released, event)
  })

  it("rejects invalid worker and batch settings before acquiring a lease", async () => {
    const jobs = { claim: async () => null, releaseLease: async () => false } satisfies JobLeaseRepository
    const outbox = {
      claim: async (): Promise<OutboxLease[]> => [],
      markPublished: async (): Promise<void> => undefined,
      releaseLease: async (): Promise<boolean> => false,
    } satisfies OutboxLeaseRepository
    assert.throws(() => new JobWorker("", 1_000, jobs, async () => undefined), /worker id is required/)
    assert.throws(() => new JobWorker("worker-1", 0, jobs, async () => undefined), /lease duration/)
    assert.throws(() => new OutboxDispatcher("", 1_000, outbox, async () => undefined), /worker id is required/)
    assert.throws(() => new OutboxDispatcher("publisher-1", 0, outbox, async () => undefined), /lease duration/)
    const worker = new JobWorker("worker-1", 1_000, jobs, async () => undefined)
    await assert.rejects(() => worker.process(""), /job id is required/)
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, outbox, async () => undefined)
    await assert.rejects(() => dispatcher.dispatch(0), /outbox claim limit/)
    await assert.rejects(() => dispatcher.dispatch(101), /outbox claim limit/)
  })

  it("does not acquire work after shutdown cancellation", async () => {
    let jobClaims = 0
    let outboxClaims = 0
    const jobs = {
      claim: async () => {
        jobClaims += 1
        return claim
      },
      releaseLease: async () => false,
    } satisfies JobLeaseRepository
    const outbox = {
      claim: async (): Promise<OutboxLease[]> => {
        outboxClaims += 1
        return [event]
      },
      markPublished: async (): Promise<void> => undefined,
      releaseLease: async (): Promise<boolean> => false,
    } satisfies OutboxLeaseRepository
    const controller = new AbortController()
    controller.abort(new Error("shutdown"))
    await assert.rejects(() => new JobWorker("worker-1", 1_000, jobs, async () => undefined).process("job-1", controller.signal), /shutdown/)
    await assert.rejects(() => new OutboxDispatcher("publisher-1", 1_000, outbox, async () => undefined).dispatch(25, controller.signal), /shutdown/)
    assert.equal(jobClaims, 0)
    assert.equal(outboxClaims, 0)
  })

  it("passes shutdown cancellation into an active job handler", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const jobs = { claim: async () => claim, releaseLease: async () => false } satisfies JobLeaseRepository
    const worker = new JobWorker("worker-1", 1_000, jobs, async (_leased, signal) => {
      observedSignal = signal
      controller.abort(new Error("shutdown"))
      signal?.throwIfAborted()
    })
    await assert.rejects(() => worker.process("job-1", controller.signal), /shutdown/)
    assert.equal(observedSignal, controller.signal)
  })

  it("releases the exact job fence when shutdown lands during lease acquisition", async () => {
    const controller = new AbortController()
    let handled = false
    let released: ClaimedJob["lease"] | null = null
    const jobs = {
      claim: async () => {
        controller.abort(new Error("shutdown"))
        return claim
      },
      releaseLease: async (lease: ClaimedJob["lease"]): Promise<boolean> => {
        released = lease
        return true
      },
    } satisfies JobLeaseRepository
    const worker = new JobWorker("worker-1", 1_000, jobs, async () => {
      handled = true
    })
    await assert.rejects(() => worker.process("job-1", controller.signal), /shutdown/)
    assert.equal(released, claim.lease)
    assert.equal(handled, false)
  })

  it("finishes acknowledgement for a published event before honoring shutdown", async () => {
    const acknowledged: string[] = []
    const released: string[] = []
    const controller = new AbortController()
    const second = { ...event, id: "event-2", aggregateSequence: 2, fencingToken: "3" }
    const outbox = {
      claim: async (): Promise<OutboxLease[]> => [event, second],
      markPublished: async (id: string): Promise<void> => {
        acknowledged.push(id)
      },
      releaseLease: async (lease: OutboxLease): Promise<boolean> => {
        released.push(lease.id)
        return true
      },
    } satisfies OutboxLeaseRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, outbox, async (leased, signal) => {
      assert.equal(signal, controller.signal)
      if (leased.id === event.id) controller.abort(new Error("shutdown"))
    })
    await assert.rejects(() => dispatcher.dispatch(2, controller.signal), /shutdown/)
    assert.deepEqual(acknowledged, [event.id])
    assert.deepEqual(released, [second.id])
  })

  it("releases every outbox lease when shutdown lands during batch acquisition", async () => {
    const controller = new AbortController()
    const second = { ...event, id: "event-2", aggregateSequence: 2, fencingToken: "3" }
    const released: string[] = []
    let published = false
    const outbox = {
      claim: async (): Promise<OutboxLease[]> => {
        controller.abort(new Error("shutdown"))
        return [event, second]
      },
      markPublished: async (): Promise<void> => undefined,
      releaseLease: async (lease: OutboxLease): Promise<boolean> => {
        released.push(lease.id)
        return true
      },
    } satisfies OutboxLeaseRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, outbox, async () => {
      published = true
    })
    await assert.rejects(() => dispatcher.dispatch(2, controller.signal), /shutdown/)
    assert.equal(published, false)
    assert.deepEqual(released, [event.id, second.id])
  })

  it("attempts every outbox release when one release fails", async () => {
    const second = { ...event, id: "event-2", aggregateSequence: 2, fencingToken: "3" }
    const released: string[] = []
    const outbox = {
      claim: async (): Promise<OutboxLease[]> => [event, second],
      markPublished: async (): Promise<void> => undefined,
      releaseLease: async (lease: OutboxLease): Promise<boolean> => {
        released.push(lease.id)
        if (lease.id === event.id) throw new Error("release unavailable")
        return true
      },
    } satisfies OutboxLeaseRepository
    const dispatcher = new OutboxDispatcher("publisher-1", 1_000, outbox, async () => {
      throw new Error("publisher unavailable")
    })
    await assert.rejects(() => dispatcher.dispatch(2), AggregateError)
    assert.deepEqual(released, [event.id, second.id])
  })
})
