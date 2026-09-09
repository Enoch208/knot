import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { createDatabasePool } from "../../../packages/db/src/index.ts"
import { parseWorkerConfig } from "./worker-config.ts"
import {
  createChainActionRecovery,
  PostgresWorkerMonitor,
  runWorkerCycle,
  type WorkerCycle,
} from "./worker-runtime.ts"

const run = async (): Promise<void> => {
  const config = parseWorkerConfig(process.env)
  const pool = createDatabasePool(config.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  const monitor = new PostgresWorkerMonitor(pool)
  const recovery = config.chainRecovery
    ? createChainActionRecovery(pool, config.chainRecovery, `knot-worker-${randomUUID()}`)
    : null
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    while (!controller.signal.aborted) {
      let cycle: WorkerCycle
      try {
        cycle = await runWorkerCycle(
          monitor,
          recovery,
          config.chainRecovery?.scanLimit ?? 1,
          controller.signal,
        )
      } catch (error) {
        if (controller.signal.aborted) break
        throw error
      }
      const recoveryStatus = cycle.recovery === null ? { enabled: false } : {
        enabled: true,
        claimedJobs: cycle.recovery.claimedJobs,
        examinedActions: cycle.recovery.examinedActions,
        changedActions: cycle.recovery.changedActions,
        queueExhausted: cycle.recovery.queueExhausted,
        loadFailures: cycle.recovery.failures.filter((failure) => failure.phase === "LOAD").length,
        reconcileFailures: cycle.recovery.failures.filter((failure) => failure.phase === "RECONCILE").length,
      }
      process.stderr.write(`${JSON.stringify({ service: "knot-worker", status: "monitoring", activeJobs: cycle.counts.activeJobs, unpublishedOutbox: cycle.counts.unpublishedOutbox, recovery: recoveryStatus })}\n`)
      try {
        await delay(config.pollMilliseconds, undefined, { signal: controller.signal })
      } catch (error) {
        if (!controller.signal.aborted) throw error
      }
    }
  } finally {
    await pool.end()
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown worker failure"
  process.stderr.write(`${JSON.stringify({ service: "knot-worker", status: "failed", message })}\n`)
  process.exitCode = 1
})
