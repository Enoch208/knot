import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ChainActionRecoveryWorker } from "../../apps/worker/src/chain-action-recovery-worker.ts"
import type { ChainActionRecord } from "../../packages/db/src/chain-action-repository.ts"
import type { ClaimedJob, WorkerLease } from "../../packages/db/src/index.ts"

const lease: WorkerLease = {
  jobId: "job-1",
  workerId: "recovery-1",
  fencingToken: "3",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
}

const action = (id: string, sequence: number): ChainActionRecord => ({
  id,
  jobId: lease.jobId,
  sessionId: "session-1",
  taskId: "task-1",
  actionSequence: sequence,
  semanticAction: "fund",
  signerAddress: "0x1111111111111111111111111111111111111111",
  accountAddress: "0x1111111111111111111111111111111111111111",
  chainId: 97,
  nonce: String(sequence + 1),
  relayIntentId: null,
  requestHash: `0x${"1".repeat(64)}`,
  transactionIntent: {
    schemaVersion: "knot.evm-transaction-intent/1",
    taskId: "task-1",
    actionSequence: sequence,
    semanticAction: "fund",
    signerAddress: "0x1111111111111111111111111111111111111111",
    accountAddress: "0x1111111111111111111111111111111111111111",
    chainId: 97,
    nonce: String(sequence + 1),
    destination: "0x2222222222222222222222222222222222222222",
    valueUnits: "0",
    calldataHash: `0x${"1".repeat(64)}`,
    gasLimit: "21000",
    gasPriceUnits: "1",
  },
  transactionHash: null,
  state: "UNKNOWN",
  reconciliation: {},
  version: 1,
})

const claimedJob = (): ClaimedJob => ({
  job: {
    id: lease.jobId,
    buyer: "0x1111111111111111111111111111111111111111",
    endpoint: "/api/jobs",
    idempotencyKey: "request-1",
    taskId: "task-1",
    quoteId: "quote-1",
    chainId: 97,
    commerce: "0x2222222222222222222222222222222222222222",
    chainJobId: "1203",
    workState: "PAYMENT_OBSERVED",
    financialState: "UNKNOWN",
    protocolState: {},
    version: 2,
    fencingToken: lease.fencingToken,
    leaseOwner: lease.workerId,
    leaseExpiresAt: lease.expiresAt,
    createdAt: new Date("2026-09-09T00:00:00Z"),
    updatedAt: new Date("2026-09-09T00:00:00Z"),
  },
  lease,
})

describe("chain action recovery worker", () => {
  it("claims each discovered job before reading or reconciling its actions", async () => {
    const calls: string[] = []
    const source = {
      nextActiveForJob: async (observedLease: WorkerLease): Promise<ChainActionRecord> => {
        assert.deepEqual(observedLease, lease)
        calls.push("read")
        return action("action-1", 0)
      },
    }
    let available = true
    const jobs = {
      claimChainActionRecovery: async (workerId: string, leaseMilliseconds: number): Promise<ClaimedJob | null> => {
        assert.deepEqual({ workerId, leaseMilliseconds }, {
          workerId: lease.workerId,
          leaseMilliseconds: 30_000,
        })
        calls.push("claim")
        if (!available) return null
        available = false
        return claimedJob()
      },
      releaseChainActionRecovery: async (): Promise<boolean> => true,
    }
    const reconciler = {
      reconcile: async (observedAction: ChainActionRecord, observedLease: WorkerLease) => {
        assert.deepEqual(observedLease, lease)
        calls.push(observedAction.id)
        return {
          action: observedAction,
          changed: observedAction.id === "action-1",
          decision: {
            nextState: null,
            transactionHash: null,
            reason: "RECEIPT_UNAVAILABLE" as const,
            reconciliation: {},
          },
        }
      },
    }
    const result = await new ChainActionRecoveryWorker(
      lease.workerId,
      30_000,
      source,
      jobs,
      reconciler,
    ).scan(10)
    assert.deepEqual(calls, ["claim", "read", "action-1", "claim"])
    assert.deepEqual(result, {
      claimedJobs: 1,
      examinedActions: 1,
      changedActions: 1,
      queueExhausted: true,
      failures: [],
    })
  })

  it("does not read actions when another worker owns the job lease", async () => {
    let read = false
    let reconciled = false
    const source = {
      nextActiveForJob: async (): Promise<ChainActionRecord | null> => {
        read = true
        return null
      },
    }
    const jobs = {
      claimChainActionRecovery: async (): Promise<null> => null,
      releaseChainActionRecovery: async (): Promise<boolean> => true,
    }
    const reconciler = {
      reconcile: async (observedAction: ChainActionRecord) => {
        reconciled = true
        throw new Error(observedAction.id)
      },
    }
    const result = await new ChainActionRecoveryWorker("recovery-2", 30_000, source, jobs, reconciler).scan(10)
    assert.equal(read, false)
    assert.equal(reconciled, false)
    assert.deepEqual(result, {
      claimedJobs: 0,
      examinedActions: 0,
      changedActions: 0,
      queueExhausted: true,
      failures: [],
    })
  })

  it("isolates one reconciliation failure and continues with the next job", async () => {
    const secondLease: WorkerLease = { ...lease, jobId: "job-2", fencingToken: "4" }
    const secondClaim = claimedJob()
    secondClaim.job.id = secondLease.jobId
    secondClaim.job.fencingToken = secondLease.fencingToken
    secondClaim.lease = secondLease
    const claims: Array<ClaimedJob | null> = [claimedJob(), secondClaim, null]
    const jobs = {
      claimChainActionRecovery: async (): Promise<ClaimedJob | null> => claims.shift() ?? null,
      releaseChainActionRecovery: async (): Promise<boolean> => true,
    }
    const source = {
      nextActiveForJob: async (observedLease: WorkerLease): Promise<ChainActionRecord> => observedLease.jobId === lease.jobId
        ? action("action-fails", 0)
        : { ...action("action-next-job", 0), jobId: secondLease.jobId },
    }
    const reconciler = {
      reconcile: async (observedAction: ChainActionRecord) => {
        if (observedAction.id === "action-fails") throw new Error("isolated")
        return {
          action: observedAction,
          changed: true,
          decision: {
            nextState: "CONFIRMED" as const,
            transactionHash: `0x${"2".repeat(64)}`,
            reason: "CONFIRMED_SUCCESS" as const,
            reconciliation: {},
          },
        }
      },
    }
    const result = await new ChainActionRecoveryWorker("recovery-1", 30_000, source, jobs, reconciler).scan(3)
    assert.deepEqual(result, {
      claimedJobs: 2,
      examinedActions: 2,
      changedActions: 1,
      queueExhausted: true,
      failures: [{ jobId: lease.jobId, actionId: "action-fails", phase: "RECONCILE" }],
    })
  })

  it("rejects invalid worker, lease, and scan configuration", async () => {
    const source = {
      nextActiveForJob: async (): Promise<ChainActionRecord | null> => null,
    }
    const jobs = {
      claimChainActionRecovery: async (): Promise<null> => null,
      releaseChainActionRecovery: async (): Promise<boolean> => true,
    }
    const reconciler = {
      reconcile: async (observedAction: ChainActionRecord) => {
        throw new Error(observedAction.id)
      },
    }
    assert.throws(() => new ChainActionRecoveryWorker("", 30_000, source, jobs, reconciler), /worker id is required/)
    assert.throws(() => new ChainActionRecoveryWorker("recovery-1", 1_000, source, jobs, reconciler), /safety margin/)
    await assert.rejects(
      () => new ChainActionRecoveryWorker("recovery-1", 30_000, source, jobs, reconciler).scan(0),
      /scan limit/,
    )
  })

  it("aborts an active reconciliation and releases its exact fenced lease", async () => {
    const controller = new AbortController()
    let released: WorkerLease | null = null
    const source = {
      nextActiveForJob: async (): Promise<ChainActionRecord> => action("action-aborted", 0),
    }
    const jobs = {
      claimChainActionRecovery: async (): Promise<ClaimedJob> => claimedJob(),
      releaseChainActionRecovery: async (observedLease: WorkerLease): Promise<boolean> => {
        released = observedLease
        return true
      },
    }
    const reconciler = {
      reconcile: async (_observedAction: ChainActionRecord, _observedLease: WorkerLease, signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        throw new Error("unreachable")
      },
    }
    const scan = new ChainActionRecoveryWorker("recovery-1", 30_000, source, jobs, reconciler).scan(
      1,
      controller.signal,
    )
    setTimeout(() => controller.abort(new Error("shutdown")), 5)
    await assert.rejects(scan, /shutdown/)
    assert.deepEqual(released, lease)
  })
})
