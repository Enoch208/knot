import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  chainRecoveryRolloutLimitations,
  deriveChainRecoveryRolloutSummary,
  verifyChainRecoveryRolloutEvidence,
  verifyChainRecoveryRolloutPublicationBindings,
} from "../../packages/reliability/src/chain-recovery-rollout.ts"

const evidencePath = "evidence/operations/chain-recovery-rollout-20260909.json"
const jobPath = "evidence/testnet/external-paid-job-1203.json"

function readEvidence(): Record<string, unknown> {
  return JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>
}

function readJob(): unknown {
  return JSON.parse(readFileSync(jobPath, "utf8")) as unknown
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

test("verifies the deployed gate, empty queue, and isolated known-hash observation", () => {
  const evidence = verifyChainRecoveryRolloutEvidence(readEvidence(), readJob())
  assert.deepEqual(deriveChainRecoveryRolloutSummary(evidence), {
    releaseTag: "35def38e730e",
    immutableImageId: "sha256:e2f11219338b090a3b3e8cb6036ad9f7368bc4739ff7de68cca92d3ca4bb3d06",
    workerSampleCount: 2,
    publicCheckCount: 5,
    receiptTransactionHash: "0xee8c816faceaea83f0eb9745e72230bde2190f439a4cac9ef8181162d54582bf",
    receiptBlockNumber: "130060913",
    receiptConfirmations: 11022,
  })
  assert.deepEqual(evidence.limitations, chainRecoveryRolloutLimitations)
})

test("rejects flattering queue, recovery, and mutation edits", () => {
  const base = readEvidence()
  const cases = [
    ["database", "chainActionCountAtRollout", 1],
    ["configuration", "recoveryEnabled", false],
    ["boundary", "recoveryTransitions", 1],
    ["boundary", "transactionBroadcasts", 1],
    ["receiptProbe", "databaseUsed", true],
  ] as const
  for (const [section, key, value] of cases) {
    const changed = clone(base)
    ;(changed[section] as Record<string, unknown>)[key] = value
    assert.throws(() => verifyChainRecoveryRolloutEvidence(changed, readJob()))
  }
})

test("rejects substituted release, public endpoint, and receipt identity", () => {
  const release = readEvidence()
  ;(release.release as Record<string, unknown>).releaseTag = "aaaaaaaaaaaa"
  assert.throws(() => verifyChainRecoveryRolloutEvidence(release, readJob()))
  const endpoint = readEvidence()
  const checks = endpoint.publicChecks as Array<Record<string, unknown>>
  checks[1]!.url = "https://example.com/card"
  assert.throws(() => verifyChainRecoveryRolloutEvidence(endpoint, readJob()))
  const receipt = readEvidence()
  const probe = receipt.receiptProbe as Record<string, unknown>
  const source = probe.source as Record<string, unknown>
  source.transactionHash = `0x${"0".repeat(64)}`
  assert.throws(() => verifyChainRecoveryRolloutEvidence(receipt, readJob()), /does not match job 1203 funding/)
  const confirmations = readEvidence()
  const confirmationProbe = confirmations.receiptProbe as Record<string, unknown>
  const confirmationSource = confirmationProbe.source as Record<string, unknown>
  confirmationSource.confirmations = 11023
  assert.throws(() => verifyChainRecoveryRolloutEvidence(confirmations, readJob()))
  const sample = readEvidence()
  const samples = sample.workerSamples as Array<Record<string, unknown>>
  samples[0]!.observedAtUtc = "2026-09-09T18:33:29.878609276Z"
  assert.throws(() => verifyChainRecoveryRolloutEvidence(sample, readJob()))
})

test("published evidence excludes private deployment and secret material", () => {
  const raw = readFileSync(evidencePath, "utf8")
  assert.doesNotMatch(raw, /\/opt\/knot\/releases/)
  assert.doesNotMatch(raw, /(?:postgresql|postgres):\/\//)
  assert.doesNotMatch(raw, /https?:\/\/[^/\s"]+@/)
  assert.doesNotMatch(raw, /backup.*(?:path|hash)/i)
})

test("claim and public documentation remain derived from rollout evidence", () => {
  const ledger = JSON.parse(readFileSync("evidence/claims.json", "utf8")) as { claims: Array<Record<string, unknown>> }
  const claim = ledger.claims.find((candidate) => candidate.id === "chain-action-recovery-kernel")
  if (claim === undefined) throw new Error("chain recovery claim is missing")
  const readme = readFileSync("README.md", "utf8")
  const reproduce = readFileSync("REPRODUCE.md", "utf8")
  const summary = verifyChainRecoveryRolloutPublicationBindings(readEvidence(), readJob(), claim, readme, reproduce)
  assert.equal(summary.releaseTag, "35def38e730e")
  const changed = clone(claim)
  ;(changed.scope as Record<string, unknown>).deployedKnownHashReceiptObservations = 2
  assert.throws(() => verifyChainRecoveryRolloutPublicationBindings(readEvidence(), readJob(), changed, readme, reproduce), /scope/)
})
