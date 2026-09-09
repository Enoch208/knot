import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { readAndVerifyClaimLedger } from "../../packages/evidence/src/index.ts"
import { verifySellerAvailabilityEvidence, verifySellerAvailabilityPublicationBindings } from "../../packages/reliability/src/seller-availability.ts"

const evidencePath = "evidence/operations/seller-availability-20260909.json"
const readEvidence = (): unknown => JSON.parse(readFileSync(evidencePath, "utf8"))
const cloneEvidence = (): Record<string, unknown> => structuredClone(verifySellerAvailabilityEvidence(readEvidence()))
const rounds = (evidence: Record<string, unknown>): Array<Record<string, unknown>> => evidence.rounds as Array<Record<string, unknown>>
const sellers = (round: Record<string, unknown>): Array<Record<string, unknown>> => round.sellers as Array<Record<string, unknown>>
const bodies = (evidence: Record<string, unknown>): Array<Record<string, unknown>> => evidence.capturedBodies as Array<Record<string, unknown>>
const readClaim = () => {
  const ledger = readAndVerifyClaimLedger("evidence/claims.json", process.cwd())
  return ledger.claims.find((claim) => claim.id === "seller-short-availability-observation")!
}

test("availability evidence verifies five samples for every public seller", () => {
  const evidence = verifySellerAvailabilityEvidence(readEvidence())
  assert.equal(evidence.rounds.length, 5)
  assert.equal(evidence.rounds.flatMap((round) => round.sellers).length, 20)
  for (const round of evidence.rounds) {
    assert.deepEqual(round.sellers.map((seller) => seller.key), ["healthguard", "rangepilot", "gridquant", "yieldscout"])
    for (const seller of round.sellers) {
      assert.equal(seller.requests.agentCard.httpStatus, 200)
      assert.equal(seller.requests.domainRegistration.httpStatus, 200)
      assert.equal(seller.requests.unauthenticatedInvocation.httpStatus, 401)
    }
  }
})

test("availability evidence reproduces captured identities and public aggregate claims", () => {
  const evidence = verifySellerAvailabilityEvidence(readEvidence())
  assert.ok(evidence.capturedBodies.length >= 8)
  const summary = verifySellerAvailabilityPublicationBindings(evidence, readClaim(), readFileSync("README.md", "utf8"))
  assert.deepEqual(summary, {
    observationDurationMs: evidence.observationDurationMs,
    expectedResponseCount: 60,
    matchedResponseCount: 60,
    minimumObservedRequestLatencyMs: Math.min(...evidence.rounds.flatMap((round) => round.sellers.flatMap((seller) => Object.values(seller.requests).map((request) => request.latencyMs)))),
    maximumObservedRequestLatencyMs: Math.max(...evidence.rounds.flatMap((round) => round.sellers.flatMap((seller) => Object.values(seller.requests).map((request) => request.latencyMs)))),
  })
})

test("availability evidence preserves the no-auth no-chain no-mutation boundary", () => {
  const evidence = verifySellerAvailabilityEvidence(readEvidence())
  assert.deepEqual(evidence.boundary, {
    authenticatedRequests: 0,
    chainRpcRequests: 0,
    stateChangingActions: 0,
    transactionSubmissions: 0,
    fundTransferCommands: 0,
  })
})

test("availability verifier rejects a forged successful status", () => {
  const evidence = cloneEvidence()
  const requests = sellers(rounds(evidence)[0]!)[0]!.requests as Record<string, Record<string, unknown>>
  requests.agentCard!.httpStatus = 503
  assert.throws(() => verifySellerAvailabilityEvidence(evidence))
})

test("availability verifier rejects a substituted seller identity or path", () => {
  const identityEvidence = cloneEvidence()
  sellers(rounds(identityEvidence)[0]!)[0]!.agentId = 2297
  assert.throws(() => verifySellerAvailabilityEvidence(identityEvidence), /identity/)

  const pathEvidence = cloneEvidence()
  const requests = sellers(rounds(pathEvidence)[0]!)[0]!.requests as Record<string, Record<string, unknown>>
  requests.agentCard!.url = "https://knot-health.truematchx.com/not-the-card.json"
  assert.throws(() => verifySellerAvailabilityEvidence(pathEvidence), /card URL mismatch/)
})

test("availability verifier rejects body tampering and recomputed identity drift", () => {
  const hashEvidence = cloneEvidence()
  const captured = bodies(hashEvidence)[0]!
  captured.bodyBase64 = `${String(captured.bodyBase64).slice(0, -4)}AAAA`
  assert.throws(() => verifySellerAvailabilityEvidence(hashEvidence), /body/)

  const identityEvidence = cloneEvidence()
  const requests = sellers(rounds(identityEvidence)[0]!)[0]!.requests as Record<string, Record<string, unknown>>
  const oldHash = String(requests.agentCard!.sha256)
  const cardBody = bodies(identityEvidence).find((item) => item.sha256 === oldHash)!
  const parsed = JSON.parse(Buffer.from(String(cardBody.bodyBase64), "base64").toString("utf8")) as Record<string, unknown>
  parsed.name = "substituted-agent"
  const bytes = Buffer.from(JSON.stringify(parsed))
  const newHash = createHash("sha256").update(bytes).digest("hex")
  cardBody.sha256 = newHash
  cardBody.byteLength = bytes.byteLength
  cardBody.bodyBase64 = bytes.toString("base64")
  for (const currentRound of rounds(identityEvidence)) {
    const request = (sellers(currentRound)[0]!.requests as Record<string, Record<string, unknown>>).agentCard!
    request.sha256 = newHash
    request.byteLength = bytes.byteLength
  }
  assert.throws(() => verifySellerAvailabilityEvidence(identityEvidence), /captured card identity mismatch/)
})

test("availability verifier rejects missing or duplicate sellers", () => {
  const missingEvidence = cloneEvidence()
  const firstRound = rounds(missingEvidence)[0]!
  firstRound.sellers = sellers(firstRound).slice(0, 3)
  assert.throws(() => verifySellerAvailabilityEvidence(missingEvidence))

  const duplicateEvidence = cloneEvidence()
  const secondRound = rounds(duplicateEvidence)[1]!
  const observedSellers = sellers(secondRound)
  secondRound.sellers = [observedSellers[0], observedSellers[0], observedSellers[2], observedSellers[3]]
  assert.throws(() => verifySellerAvailabilityEvidence(duplicateEvidence), /duplicate/)
})

test("availability verifier rejects forged cadence and duration", () => {
  const cadenceEvidence = cloneEvidence()
  rounds(cadenceEvidence)[1]!.observedAtUtc = rounds(cadenceEvidence)[0]!.observedAtUtc
  assert.throws(() => verifySellerAvailabilityEvidence(cadenceEvidence), /cadence|observation boundary/)

  const durationEvidence = cloneEvidence()
  durationEvidence.observationDurationMs = 1
  assert.throws(() => verifySellerAvailabilityEvidence(durationEvidence), /duration/)
})

test("availability verifier binds latencies to the timeout and observation boundaries", () => {
  const boundaryEvidence = cloneEvidence()
  const finalRequests = sellers(rounds(boundaryEvidence)[4]!).at(-1)!.requests as Record<string, Record<string, unknown>>
  finalRequests.unauthenticatedInvocation!.latencyMs = 4_400
  assert.throws(() => verifySellerAvailabilityEvidence(boundaryEvidence), /observation boundary/)

  const timeoutEvidence = cloneEvidence()
  const firstRequests = sellers(rounds(timeoutEvidence)[0]!)[0]!.requests as Record<string, Record<string, unknown>>
  firstRequests.agentCard!.latencyMs = 10_001
  assert.throws(() => verifySellerAvailabilityEvidence(timeoutEvidence), /configured timeout/)
})

test("publication binding rejects stale latency aggregates", () => {
  const evidence = cloneEvidence()
  const requests = sellers(rounds(evidence)[0]!)[0]!.requests as Record<string, Record<string, unknown>>
  requests.agentCard!.latencyMs = 5_000
  assert.throws(
    () => verifySellerAvailabilityPublicationBindings(evidence, readClaim(), readFileSync("README.md", "utf8")),
    /maximumObservedRequestLatencyMs/,
  )
})

test("published availability evidence contains no credential material", () => {
  const raw = readFileSync(evidencePath, "utf8")
  const evidence = verifySellerAvailabilityEvidence(JSON.parse(raw))
  const decodedBodies = evidence.capturedBodies.map((body) => Buffer.from(body.bodyBase64, "base64").toString("utf8")).join("\n")
  assert.doesNotMatch(`${raw}\n${decodedBodies}`, /access[_-]?token|authorization|bearer|client[_-]?secret|password|private[_-]?key|root@|76\.13\./i)
})
