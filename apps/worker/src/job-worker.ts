import type { ClaimedJob, WorkerLease } from "../../../packages/db/src/index.ts"

export interface JobLeaseRepository {
  claim(jobId: string, workerId: string, leaseMilliseconds: number): Promise<ClaimedJob | null>
  releaseLease(lease: WorkerLease): Promise<boolean>
}

export type JobHandler = (claim: ClaimedJob, signal?: AbortSignal) => Promise<void>

export class JobWorker {
  private readonly workerId: string
  private readonly leaseMilliseconds: number
  private readonly jobs: JobLeaseRepository
  private readonly handler: JobHandler

  constructor(
    workerId: string,
    leaseMilliseconds: number,
    jobs: JobLeaseRepository,
    handler: JobHandler,
  ) {
    if (workerId.trim() === "") throw new Error("worker id is required")
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) throw new RangeError("lease duration must be a positive safe integer")
    this.workerId = workerId
    this.leaseMilliseconds = leaseMilliseconds
    this.jobs = jobs
    this.handler = handler
  }

  async process(jobId: string, signal?: AbortSignal): Promise<boolean> {
    if (jobId.trim() === "") throw new Error("job id is required")
    signal?.throwIfAborted()
    const claim = await this.jobs.claim(jobId, this.workerId, this.leaseMilliseconds)
    if (!claim) {
      return false
    }
    if (signal?.aborted) {
      await this.jobs.releaseLease(claim.lease)
      signal.throwIfAborted()
    }
    await this.handler(claim, signal)
    return true
  }
}
