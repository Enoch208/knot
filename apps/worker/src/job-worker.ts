import type { ClaimedJob, JobRepository } from "../../../packages/db/src/index.ts"

export type JobHandler = (claim: ClaimedJob) => Promise<void>

export class JobWorker {
  private readonly workerId: string
  private readonly leaseMilliseconds: number
  private readonly jobs: JobRepository
  private readonly handler: JobHandler

  constructor(
    workerId: string,
    leaseMilliseconds: number,
    jobs: JobRepository,
    handler: JobHandler,
  ) {
    this.workerId = workerId
    this.leaseMilliseconds = leaseMilliseconds
    this.jobs = jobs
    this.handler = handler
  }

  async process(jobId: string): Promise<boolean> {
    const claim = await this.jobs.claim(jobId, this.workerId, this.leaseMilliseconds)
    if (!claim) {
      return false
    }
    await this.handler(claim)
    return true
  }
}
