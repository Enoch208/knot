import type {
  ChainActionRecord,
} from "../../../packages/db/src/chain-action-repository.ts"
import type { ClaimedJob, WorkerLease } from "../../../packages/db/src/index.ts"
import type { ChainReconciliationResult } from "./chain-action-reconciler.ts"

export interface ChainActionRecoverySource {
  nextActiveForJob(lease: WorkerLease): Promise<ChainActionRecord | null>
}

export interface ChainActionJobClaimer {
  claimChainActionRecovery(workerId: string, leaseMilliseconds: number): Promise<ClaimedJob | null>
  releaseChainActionRecovery(lease: WorkerLease): Promise<boolean>
}

export interface ChainActionRecoveryReconciler {
  reconcile(action: ChainActionRecord, lease: WorkerLease, signal?: AbortSignal): Promise<ChainReconciliationResult>
}

export interface ChainActionRecoveryScan {
  claimedJobs: number
  examinedActions: number
  changedActions: number
  queueExhausted: boolean
  failures: readonly ChainActionRecoveryFailure[]
}

export interface ChainActionRecoveryFailure {
  jobId: string
  actionId: string | null
  phase: "LOAD" | "RECONCILE"
}

export class ChainActionRecoveryWorker {
  private readonly workerId: string
  private readonly leaseMilliseconds: number
  private readonly source: ChainActionRecoverySource
  private readonly jobs: ChainActionJobClaimer
  private readonly reconciler: ChainActionRecoveryReconciler

  constructor(
    workerId: string,
    leaseMilliseconds: number,
    source: ChainActionRecoverySource,
    jobs: ChainActionJobClaimer,
    reconciler: ChainActionRecoveryReconciler,
  ) {
    if (workerId.length === 0) throw new RangeError("worker id is required")
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds <= 1_000) {
      throw new RangeError("recovery lease duration must exceed the reconciliation safety margin")
    }
    this.workerId = workerId
    this.leaseMilliseconds = leaseMilliseconds
    this.source = source
    this.jobs = jobs
    this.reconciler = reconciler
  }

  async scan(limit: number, signal?: AbortSignal): Promise<ChainActionRecoveryScan> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("recovery scan limit is outside its supported range")
    }
    let claimedJobs = 0
    let examinedActions = 0
    let changedActions = 0
    let queueExhausted = false
    const failures: ChainActionRecoveryFailure[] = []
    for (let index = 0; index < limit; index += 1) {
      signal?.throwIfAborted()
      const claim = await this.jobs.claimChainActionRecovery(this.workerId, this.leaseMilliseconds)
      if (claim === null) {
        queueExhausted = true
        break
      }
      claimedJobs += 1
      if (signal?.aborted) {
        await this.jobs.releaseChainActionRecovery(claim.lease)
        signal.throwIfAborted()
      }
      let action: ChainActionRecord | null
      try {
        action = await this.source.nextActiveForJob(claim.lease)
      } catch (error) {
        if (signal?.aborted) {
          await this.jobs.releaseChainActionRecovery(claim.lease)
          throw error
        }
        failures.push({ jobId: claim.job.id, actionId: null, phase: "LOAD" })
        continue
      }
      if (signal?.aborted) {
        await this.jobs.releaseChainActionRecovery(claim.lease)
        signal.throwIfAborted()
      }
      if (action === null) continue
      examinedActions += 1
      try {
        const result = await this.reconciler.reconcile(action, claim.lease, signal)
        if (result.changed) changedActions += 1
      } catch (error) {
        if (signal?.aborted) {
          await this.jobs.releaseChainActionRecovery(claim.lease)
          throw error
        }
        failures.push({ jobId: claim.job.id, actionId: action.id, phase: "RECONCILE" })
      }
      if (signal?.aborted) {
        await this.jobs.releaseChainActionRecovery(claim.lease)
        signal.throwIfAborted()
      }
    }
    return { claimedJobs, examinedActions, changedActions, queueExhausted, failures }
  }
}
