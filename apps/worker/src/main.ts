import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { createDatabasePool } from "../../../packages/db/src/index.ts"

const environment = z.object({
  DATABASE_URL: z.string().min(1),
  KNOT_WORKER_POLL_MILLISECONDS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
})

const run = async (): Promise<void> => {
  const config = environment.parse(process.env)
  const pool = createDatabasePool(config.DATABASE_URL, {
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    while (!controller.signal.aborted) {
      const result = await pool.query<{ active_jobs: string; unpublished_outbox: string }>(
        "SELECT (SELECT count(*) FROM jobs WHERE work_state IN ('PAYMENT_OBSERVED', 'RUNNING', 'OUTPUT_RECEIVED')) AS active_jobs, (SELECT count(*) FROM outbox WHERE published_at IS NULL) AS unpublished_outbox",
      )
      const counts = result.rows[0]
      if (!counts) throw new Error("worker status query returned no result")
      process.stderr.write(`${JSON.stringify({ service: "knot-worker", status: "monitoring", activeJobs: counts.active_jobs, unpublishedOutbox: counts.unpublished_outbox })}\n`)
      try {
        await delay(config.KNOT_WORKER_POLL_MILLISECONDS, undefined, { signal: controller.signal })
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
