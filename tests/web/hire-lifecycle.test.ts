import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareFunding } from "../../apps/web/src/hire-calls.ts"
import { requestHireLifecycle } from "../../apps/web/src/hire-lifecycle-client.ts"
import { fundingProof, lifecycleView, parsePublicHireStatus } from "../../apps/web/src/hire-lifecycle.ts"
import { readJournal, saveJournal } from "../../apps/web/src/hire-journal.ts"
import type { HireJournal, PublicHireStatus } from "../../apps/web/src/hire-types.ts"
import { buyer, creationReceipt, hash, MemoryStorage, now, prepared } from "./hire-fixtures.ts"

const transactionHashes = [2, 3, 4, 5].map(value => `0x${String(value).repeat(64)}`)

function fundedJournal(): HireJournal {
  const creation = prepared()
  const funding = prepareFunding(creation, creationReceipt())
  return {
    version: 1,
    creation,
    prepared: funding,
    creationHash: hash,
    progress: transactionHashes.map(transactionHash => ({ state: "confirmed", transactionHash })),
  }
}

function liveStatus(overrides: Partial<PublicHireStatus> = {}): PublicHireStatus {
  const journal = fundedJournal()
  const proof = fundingProof(journal)
  return {
    verifiedQuoteId: journal.creation.verifiedQuoteId,
    buyer,
    jobId: "1234",
    verification: { state: "CONFIRMED", reason: null },
    chain: { chainId: 97, commerce: journal.prepared.envelope.commerce, ...proof, confirmedAtBlock: "99", confirmations: 3 },
    job: { status: "FUNDED", expiredAtUnix: now + 3600, submittedAtUnix: null, deliverableHash: null },
    lifecycle: { workState: "RUNNING", financialState: "ESCROWED" },
    sellerNotification: { state: "ACKNOWLEDGED", attemptedAtUtc: "2026-09-13T10:00:00.000Z", retryable: false },
    deliverable: { available: false, url: null },
    refund: { available: false, availableAtUnix: now + 3600, reason: null, action: "BUYER_WALLET_REQUIRED", call: null },
    ...overrides,
  }
}

test("HIRE-LIVE-01 funding proof requires five distinct confirmed saved hashes", () => {
  const journal = fundedJournal()
  assert.deepEqual(fundingProof(journal), { creationTransactionHash: hash, fundingTransactionHashes: transactionHashes })
  journal.progress[2] = { state: "unresolved", transactionHash: null }
  assert.throws(() => fundingProof(journal), /Every funding call/)
})

test("HIRE-LIVE-02 live status is bound to the saved buyer, job, commerce, and exact ordered receipts", () => {
  const journal = fundedJournal()
  const parsed = parsePublicHireStatus(liveStatus(), journal)
  assert.ok(parsed.job)
  assert.equal(parsed.job.status, "FUNDED")
  assert.throws(() => parsePublicHireStatus(liveStatus({ buyer: `0x${"8".repeat(40)}` }), journal), /verified hire boundary/)
  const wrongOrder = liveStatus()
  wrongOrder.chain.fundingTransactionHashes = [...wrongOrder.chain.fundingTransactionHashes].reverse() as [string, string, string, string]
  assert.throws(() => parsePublicHireStatus(wrongOrder, journal), /verified hire boundary/)
})

test("HIRE-LIVE-03 artifact and settlement claims require their exact canonical states", () => {
  const funded = lifecycleView({ confirmationState: "confirmed", checkedAtUtc: null, lastStatus: liveStatus() })
  assert.equal(funded.title, "Funding verified; seller work pending")
  assert.equal(funded.steps.find(step => step.label === "FUNDED")?.state, "complete")
  assert.equal(funded.steps.find(step => step.label === "SUBMITTED")?.state, "current")

  const submittedStatus = liveStatus({
    job: { status: "SUBMITTED", expiredAtUnix: now + 3600, submittedAtUnix: now, deliverableHash: transactionHashes[0]! },
    lifecycle: { workState: "OUTPUT_RECEIVED", financialState: "ESCROWED" },
    deliverable: { available: true, url: null },
  })
  const submitted = lifecycleView({ confirmationState: "confirmed", checkedAtUtc: null, lastStatus: submittedStatus })
  assert.equal(submitted.title, "Artifact submitted; verification pending")
  assert.equal(submitted.steps.find(step => step.label === "VERIFIED ARTIFACT")?.state, "current")

  const completeStatus = liveStatus({
    job: { status: "COMPLETED", expiredAtUnix: now + 3600, submittedAtUnix: now, deliverableHash: transactionHashes[0]! },
    lifecycle: { workState: "OUTPUT_CHECKED", financialState: "PAID" },
    deliverable: { available: true, url: "https://knot-api.truematchx.com/artifacts/example" },
  })
  const complete = lifecycleView({ confirmationState: "confirmed", checkedAtUtc: null, lastStatus: completeStatus })
  assert.equal(complete.title, "Hire completed")
  assert.equal(complete.steps.find(step => step.label === "COMPLETED")?.state, "complete")
})

test("HIRE-LIVE-04 refund availability is a truthful alternative path, not a completed refund", () => {
  const refundable = liveStatus({
    job: { status: "EXPIRED", expiredAtUnix: now - 1, submittedAtUnix: null, deliverableHash: null },
    lifecycle: { workState: "FAILED", financialState: "RESOLUTION_PENDING" },
    refund: { available: true, availableAtUnix: now - 1, reason: "Seller deadline expired.", action: "BUYER_WALLET_REQUIRED", call: { to: prepared().envelope.commerce, data: "0x1234", value: "0" } },
  })
  const view = lifecycleView({ confirmationState: "confirmed", checkedAtUtc: null, lastStatus: refundable })
  assert.equal(view.title, "Refund is available")
  assert.equal(view.steps.find(step => step.label === "REFUNDED")?.state, "current")
  assert.notEqual(view.steps.find(step => step.label === "REFUNDED")?.state, "complete")
})

test("HIRE-LIVE-05 lifecycle and scoped signatures survive reload but tampering fails closed", () => {
  const storage = new MemoryStorage()
  const journal = fundedJournal()
  journal.postFunding = {
    confirmationState: "confirmed",
    checkedAtUtc: "2026-09-13T10:00:00.000Z",
    lastStatus: liveStatus(),
    statusProof: { intent: "eyJ0ZXN0IjoidGVzdCJ9", signature: `0x${"a".repeat(130)}` },
  }
  saveJournal(storage, journal)
  assert.equal(readJournal(storage, journal.creation.verifiedQuoteId)?.postFunding?.lastStatus?.jobId, "1234")
  const raw = JSON.parse(storage.getItem(`knot.hire/2:${journal.creation.verifiedQuoteId}`)!) as HireJournal
  raw.postFunding!.lastStatus!.chain.creationTransactionHash = `0x${"9".repeat(64)}`
  storage.setItem(`knot.hire/2:${journal.creation.verifiedQuoteId}`, JSON.stringify(raw))
  assert.throws(() => readJournal(storage, journal.creation.verifiedQuoteId), /inconsistent/)
})

test("HIRE-LIVE-06 a saved status proof polls without another wallet signature", async () => {
  let walletCalls = 0
  let fetchCalls = 0
  const saved = { intent: "intent", signature: `0x${"a".repeat(130)}` }
  const outcome = await requestHireLifecycle(
    { request: async () => { walletCalls += 1; throw new Error("wallet must not be opened") } },
    "vq-regression",
    buyer,
    "hire-status",
    {},
    saved,
    () => { throw new Error("saved proof must be reused") },
    (async (_input, init) => {
      fetchCalls += 1
      assert.match(String(init?.body), /"stage":"SIGNED"/)
      return new Response(JSON.stringify(liveStatus()), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch,
  )
  assert.equal(outcome.status, "response")
  assert.equal(fetchCalls, 1)
  assert.equal(walletCalls, 0)
})
