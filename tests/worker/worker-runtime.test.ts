import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { runWorkerCycle, type WorkerMonitor, type WorkerRecoveryScanner } from "../../apps/worker/src/worker-runtime.ts"

describe("worker recovery wiring", () => {
  it("runs one bounded recovery scan before reading monitor counts", async () => {
    const order: string[] = []
    const recovery: WorkerRecoveryScanner = {
      scan: async (limit) => {
        order.push(`scan:${limit}`)
        return {
          claimedJobs: 1,
          examinedActions: 1,
          changedActions: 1,
          queueExhausted: false,
          failures: [],
        }
      },
    }
    const monitor: WorkerMonitor = {
      read: async () => {
        order.push("monitor")
        return { activeJobs: "2", unpublishedOutbox: "3" }
      },
    }
    assert.deepEqual(await runWorkerCycle(monitor, recovery, 2), {
      counts: { activeJobs: "2", unpublishedOutbox: "3" },
      recovery: {
        claimedJobs: 1,
        examinedActions: 1,
        changedActions: 1,
        queueExhausted: false,
        failures: [],
      },
    })
    assert.deepEqual(order, ["scan:2", "monitor"])
  })

  it("leaves recovery dormant when the rollout gate is disabled", async () => {
    const monitor: WorkerMonitor = {
      read: async () => ({ activeJobs: "0", unpublishedOutbox: "0" }),
    }
    assert.deepEqual(await runWorkerCycle(monitor, null, 1), {
      counts: { activeJobs: "0", unpublishedOutbox: "0" },
      recovery: null,
    })
  })

  it("passes shutdown cancellation into an active recovery scan", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const recovery: WorkerRecoveryScanner = {
      scan: async (_limit, signal) => {
        observedSignal = signal
        controller.abort(new Error("shutdown"))
        signal?.throwIfAborted()
        throw new Error("unreachable")
      },
    }
    const monitor: WorkerMonitor = {
      read: async () => ({ activeJobs: "0", unpublishedOutbox: "0" }),
    }
    await assert.rejects(
      () => runWorkerCycle(monitor, recovery, 1, controller.signal),
      /shutdown/,
    )
    assert.equal(observedSignal, controller.signal)
  })
})
