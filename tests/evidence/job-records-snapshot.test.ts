import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  JobRecordSourceError,
  SNAPSHOT_RELATIVE_PATH,
  SNAPSHOT_SCHEMA_VERSION,
  buildJobRecordsSnapshot,
  formatBaseUnits,
  serialiseJobRecordsSnapshot,
} from "../../scripts/build-job-records-snapshot.ts"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const snapshotPath = resolve(repositoryRoot, SNAPSHOT_RELATIVE_PATH)

const rebuild = () => buildJobRecordsSnapshot(repositoryRoot)

test("the bundled job records snapshot matches the evidence it is generated from", () => {
  const committed = readFileSync(snapshotPath, "utf8")
  const regenerated = serialiseJobRecordsSnapshot(rebuild())
  assert.equal(
    committed,
    regenerated,
    `${SNAPSHOT_RELATIVE_PATH} has drifted from evidence/testnet. Run "npm run jobs:snapshot" and commit the result.`,
  )
})

test("every recorded job carries the identity, money, and transaction fields the pages render", () => {
  const snapshot = rebuild()
  assert.equal(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
  assert.ok(snapshot.jobs.length > 0)
  assert.deepEqual(
    snapshot.jobs.map((job) => job.jobId),
    [...snapshot.jobs.map((job) => job.jobId)].sort((left, right) => Number(BigInt(left) - BigInt(right))),
  )
  for (const job of snapshot.jobs) {
    assert.match(job.jobId, /^\d+$/u)
    assert.match(job.parties.buyer, /^0x[0-9a-fA-F]{40}$/u)
    assert.match(job.parties.provider, /^0x[0-9a-fA-F]{40}$/u)
    assert.notEqual(job.parties.buyer.toLowerCase(), job.parties.provider.toLowerCase())
    assert.equal(job.parties.buyerIsProvider, false)
    assert.ok(job.transactions.length > 0)
    assert.ok(job.limitations.length > 0)
    assert.ok(snapshot.sources.includes(job.sourcePath))
    for (const transaction of job.transactions) assert.match(transaction.hash, /^0x[0-9a-fA-F]{64}$/u)
  }
})

test("failed jobs report a zero provider payment and never borrow a settled job's fields", () => {
  const failures = rebuild().jobs.filter((job) => job.settlement.classification !== "SETTLED_TO_PROVIDER")
  assert.ok(failures.length > 0)
  for (const job of failures) {
    assert.equal(job.money.providerReceivedBaseUnits, "0")
    assert.equal(job.settlement.settlementTransactionHash, null)
    assert.notEqual(job.settlement.refundTransactionHash, null)
    assert.equal(job.money.buyerRefundedBaseUnits, job.money.escrowBaseUnits)
  }
  const expired = failures.filter((job) => job.settlement.classification === "EXPIRED_WITHOUT_DELIVERY")
  assert.ok(expired.length > 0)
  for (const job of expired) {
    assert.equal(job.work.deliverySubmitted, false)
    assert.equal(job.work.deliverableUrl, null)
    assert.equal(job.work.deliverableManifestHash, null)
  }
})

test("settled jobs carry a payment transfer to the provider and a retained deliverable", () => {
  const settled = rebuild().jobs.filter((job) => job.settlement.classification === "SETTLED_TO_PROVIDER")
  assert.ok(settled.length > 0)
  for (const job of settled) {
    assert.equal(job.money.providerReceivedBaseUnits, job.money.escrowBaseUnits)
    assert.equal(job.money.buyerRefundedBaseUnits, "0")
    assert.equal(job.settlement.refundTransactionHash, null)
    assert.notEqual(job.settlement.settlementTransactionHash, null)
    assert.equal(job.settlement.terminalState, "COMPLETED")
    assert.equal(job.work.deliverySubmitted, true)
    assert.notEqual(job.work.deliverableUrl, null)
  }
})

test("an unrecognised terminal outcome fails the build instead of rendering a guess", () => {
  const document = JSON.parse(
    readFileSync(resolve(repositoryRoot, "evidence/testnet/healthguard-job-1181.json"), "utf8"),
  ) as { job: { settlementTerminalState: string; settlementTransactionHash: string | null } }
  document.job.settlementTerminalState = "PROBABLY_FINE"
  document.job.settlementTransactionHash = null
  assert.throws(
    () => buildJobRecordsSnapshot(temporaryEvidenceRoot("healthguard-job-1181.json", document)),
    (error: unknown) =>
      error instanceof JobRecordSourceError && error.message.includes("unrecognised terminal outcome"),
  )
})

test("an evidence directory with no job documents fails the build", () => {
  assert.throws(
    () => buildJobRecordsSnapshot(mkdtempSync(join(tmpdir(), "knot-job-records-empty-"))),
    (error: unknown) => error instanceof Error,
  )
})

test("amounts are formatted from base units without floating point arithmetic", () => {
  assert.equal(formatBaseUnits("100000000000000000", 18, "U"), "0.1 U")
  assert.equal(formatBaseUnits("10000000000000000", 18, "U"), "0.01 U")
  assert.equal(formatBaseUnits("0", 18, "U"), "0 U")
  assert.equal(formatBaseUnits("1000000000000000000", 18, "U"), "1 U")
})

function temporaryEvidenceRoot(name: string, document: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "knot-job-records-"))
  mkdirSync(join(root, "evidence/testnet"), { recursive: true })
  writeFileSync(join(root, "evidence/testnet", name), JSON.stringify(document))
  return root
}
