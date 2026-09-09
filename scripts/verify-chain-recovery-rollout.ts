import { readFileSync } from "node:fs"
import {
  deriveChainRecoveryRolloutSummary,
  verifyChainRecoveryRolloutEvidence,
} from "../packages/reliability/src/chain-recovery-rollout.ts"

const evidence = JSON.parse(readFileSync("evidence/operations/chain-recovery-rollout-20260909.json", "utf8")) as unknown
const job = JSON.parse(readFileSync("evidence/testnet/external-paid-job-1203.json", "utf8")) as unknown
const verified = verifyChainRecoveryRolloutEvidence(evidence, job)
const summary = deriveChainRecoveryRolloutSummary(verified)

process.stdout.write(`${JSON.stringify({
  status: "VERIFIED_DEPLOYED_READ_ONLY_RECOVERY",
  rolloutCapturedAtUtc: verified.rolloutCapturedAtUtc,
  observedUntilUtc: verified.observedUntilUtc,
  release: {
    releaseTag: summary.releaseTag,
    immutableImageId: summary.immutableImageId,
  },
  servicesHealthy: verified.services.map((service) => service.role),
  publicHttp200Checks: summary.publicCheckCount,
  workerSamples: summary.workerSampleCount,
  emptyQueue: {
    chainActionsAtRollout: verified.database.chainActionCountAtRollout,
    chainActionsAfterProbe: verified.database.chainActionCountAfterProbe,
    recoveryTransitions: verified.boundary.recoveryTransitions,
  },
  receiptProbe: {
    status: verified.receiptProbe.status,
    transactionHash: summary.receiptTransactionHash,
    blockNumber: summary.receiptBlockNumber,
    confirmations: summary.receiptConfirmations,
    databaseUsed: verified.receiptProbe.databaseUsed,
    walletUsed: verified.receiptProbe.walletUsed,
    queueUsed: verified.receiptProbe.queueUsed,
  },
  boundary: verified.boundary,
  limitations: verified.limitations,
}, null, 2)}\n`)
