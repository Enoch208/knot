import type { Pool } from "pg"
import { ChainActionRepository, JobRepository } from "../../../packages/db/src/index.ts"
import { BscChainReceiptObserver, SafeBscReadRpcTransport } from "./bsc-chain-receipt-observer.ts"
import { ChainActionReconciler } from "./chain-action-reconciler.ts"
import { ChainActionRecoveryWorker, type ChainActionRecoveryScan } from "./chain-action-recovery-worker.ts"
import type { ChainRecoveryConfig } from "./worker-config.ts"

export interface WorkerCounts {
  activeJobs: string
  unpublishedOutbox: string
}

export interface WorkerMonitor {
  read(): Promise<WorkerCounts>
}

export interface WorkerRecoveryScanner {
  scan(limit: number, signal?: AbortSignal): Promise<ChainActionRecoveryScan>
}

export interface WorkerCycle {
  counts: WorkerCounts
  recovery: ChainActionRecoveryScan | null
}

export class PostgresWorkerMonitor implements WorkerMonitor {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async read(): Promise<WorkerCounts> {
    const result = await this.pool.query<{ active_jobs: string; unpublished_outbox: string }>(
      "SELECT (SELECT count(*) FROM jobs WHERE work_state IN ('PAYMENT_OBSERVED', 'RUNNING', 'OUTPUT_RECEIVED')) AS active_jobs, (SELECT count(*) FROM outbox WHERE published_at IS NULL) AS unpublished_outbox",
    )
    const counts = result.rows[0]
    if (!counts) throw new Error("worker status query returned no result")
    return { activeJobs: counts.active_jobs, unpublishedOutbox: counts.unpublished_outbox }
  }
}

export function createChainActionRecovery(
  pool: Pool,
  config: ChainRecoveryConfig,
  workerId: string,
): ChainActionRecoveryWorker {
  const jobs = new JobRepository(pool)
  const actions = new ChainActionRepository(pool)
  const observer = new BscChainReceiptObserver(
    config.rpcUrls,
    new SafeBscReadRpcTransport(config.observationTimeoutMilliseconds),
  )
  const reconciler = new ChainActionReconciler(
    observer,
    actions,
    config.confirmationPolicy,
    undefined,
    config.observationTimeoutMilliseconds,
  )
  return new ChainActionRecoveryWorker(workerId, config.leaseMilliseconds, actions, jobs, reconciler)
}

export async function runWorkerCycle(
  monitor: WorkerMonitor,
  recovery: WorkerRecoveryScanner | null,
  scanLimit: number,
  signal?: AbortSignal,
): Promise<WorkerCycle> {
  signal?.throwIfAborted()
  const recoveryResult = recovery ? await recovery.scan(scanLimit, signal) : null
  signal?.throwIfAborted()
  return { counts: await monitor.read(), recovery: recoveryResult }
}
