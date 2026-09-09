import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  ThirdPartyAuditionError,
  thirdPartyAuditionReport,
  verifyThirdPartyAudition,
} from "../../packages/discovery/src/index.ts"

type JsonObject = Record<string, unknown>

function evidence(): JsonObject {
  return JSON.parse(readFileSync("evidence/testnet/third-party-health-audition-expanded.json", "utf8")) as JsonObject
}

function assertObject(value: unknown): asserts value is JsonObject {
  assert.equal(typeof value, "object")
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}

function candidate(report: JsonObject, agentId: string): JsonObject {
  const candidates = report.candidates
  assert.ok(Array.isArray(candidates))
  const match = candidates.find((value) => {
    assertObject(value)
    const identity = value.identity
    assertObject(identity)
    return identity.agentId === agentId
  })
  assertObject(match)
  return match
}

test("the expanded audition separates registration, availability, task, quote, and hireability", () => {
  const report = verifyThirdPartyAudition(evidence())
  assert.deepEqual(report.candidates.map((value) => value.identity.agentId), ["2296", "2288", "2286", "2238", "2233"])
  assert.equal(report.candidates.some((value) => value.identity.agentId === "2293"), false)
  assert.deepEqual(report.safety, {
    walletSignaturesRequested: false,
    paymentsAttempted: false,
    chainWritesAttempted: false,
    purchasesAttempted: false,
  })
  assert.deepEqual({
    registered: report.summary.registeredCount,
    endpointLive: report.summary.endpointLiveCount,
    callable: report.summary.callableCount,
    quoteCapable: report.summary.quoteCapableCount,
    hireable: report.summary.hireableCount,
  }, {
    registered: 5,
    endpointLive: 3,
    callable: 1,
    quoteCapable: 0,
    hireable: 0,
  })
})

test("Keel's completed task remains partial because it ignored the requested block", () => {
  const report = verifyThirdPartyAudition(evidence())
  const keel = report.candidates.find((value) => value.identity.agentId === "2238")
  assert.ok(keel)
  assert.equal(keel.stages.callable.outcome, "VERIFIED")
  assert.equal(keel.compatibility.comparisonToKnotHealthGuard, "PARTIAL")
  assert.match(keel.compatibility.detail, /120862609/)
  assert.match(keel.compatibility.detail, /120873658/)
  assert.notEqual(keel.stages.quoteCapable.outcome, "VERIFIED")
  assert.notEqual(keel.stages.hireable.outcome, "VERIFIED")
})

test("an unsigned task-unbound price response cannot become quote-capable", () => {
  const report = evidence()
  const guardian = candidate(report, "2286")
  const stages = guardian.stages
  assertObject(stages)
  const callable = stages.callable
  const quote = stages.quoteCapable
  assertObject(callable)
  assertObject(quote)
  callable.outcome = "VERIFIED"
  callable.httpStatus = 200
  quote.outcome = "VERIFIED"
  assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)
  assert.throws(() => verifyThirdPartyAudition(report), ThirdPartyAuditionError)
})

test("quote ownership and no-acceptance facts are closed evidence", () => {
  const wrongOwner = evidence()
  const guardian = candidate(wrongOwner, "2286")
  const quote = guardian.quoteObservation
  assertObject(quote)
  quote.providerAddress = "0x0000000000000000000000000000000000000001"
  assert.equal(thirdPartyAuditionReport.safeParse(wrongOwner).success, false)

  const accepted = evidence()
  const acceptedQuote = candidate(accepted, "2286").quoteObservation
  assertObject(acceptedQuote)
  acceptedQuote.acceptedByKnot = true
  assert.equal(thirdPartyAuditionReport.safeParse(accepted).success, false)

  const expiredEarly = evidence()
  const earlyQuote = candidate(expiredEarly, "2286").quoteObservation
  assertObject(earlyQuote)
  earlyQuote.expiresAtUnix = "1788957390"
  assert.equal(thirdPartyAuditionReport.safeParse(expiredEarly).success, false)
})
