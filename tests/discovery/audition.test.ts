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
  return JSON.parse(readFileSync("evidence/testnet/third-party-health-audition-2293.json", "utf8")) as JsonObject
}

function firstCandidate(report: JsonObject): JsonObject {
  const candidates = report.candidates
  assert.ok(Array.isArray(candidates))
  const candidate = candidates[0]
  assertObject(candidate)
  return candidate
}

function stages(report: JsonObject): JsonObject {
  const value = firstCandidate(report).stages
  assertObject(value)
  return value
}

function assertObject(value: unknown): asserts value is JsonObject {
  assert.equal(typeof value, "object")
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}

test("the published third-party preflight stops at a live endpoint", () => {
  const report = verifyThirdPartyAudition(evidence())
  assert.deepEqual(report.safety, {
    walletSignaturesRequested: false,
    paymentsAttempted: false,
    chainWritesAttempted: false,
    purchasesAttempted: false,
  })
  assert.deepEqual(report.summary, {
    registeredCount: 1,
    endpointLiveCount: 1,
    callableCount: 0,
    quoteCapableCount: 0,
    hireableCount: 0,
    conclusion: "Agent 97:2293 is registered and its card was live, but this observation did not establish a callable compatible task, quote capability, or hireability.",
  })
  assert.equal(report.candidates[0]!.stages.callable.outcome, "UNVERIFIED")
  assert.equal(report.candidates[0]!.stages.quoteCapable.reasonCode, "COMMERCE_DISABLED")
  assert.equal(report.candidates[0]!.operatorRelationship.status, "NOT_PROVEN")
  assert.equal(report.candidates[0]!.compatibility.comparisonToKnotHealthGuard, "PARTIAL")
})

test("a live card or protocol error cannot be relabelled callable", () => {
  const report = evidence()
  const candidateStages = stages(report)
  const callable = candidateStages.callable
  assertObject(callable)
  callable.outcome = "VERIFIED"
  assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)
  assert.throws(() => verifyThirdPartyAudition(report), ThirdPartyAuditionError)
})

test("quote-capable cannot be verified before a compatible callable task", () => {
  const report = evidence()
  const candidateStages = stages(report)
  const quote = candidateStages.quoteCapable
  assertObject(quote)
  quote.outcome = "VERIFIED"
  assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)
})

test("hireable requires every prior stage and a durable endpoint", () => {
  const report = evidence()
  const candidate = firstCandidate(report)
  const candidateStages = stages(report)
  for (const key of ["callable", "quoteCapable", "hireable"]) {
    const stage = candidateStages[key]
    assertObject(stage)
    stage.outcome = "VERIFIED"
    stage.httpStatus = key === "hireable" ? null : 200
  }
  const advertised = candidate.advertised
  assertObject(advertised)
  advertised.quoteAdvertised = true
  assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)
})

test("a distinct-owner relationship cannot claim the same registry owner", () => {
  const report = evidence()
  const candidate = firstCandidate(report)
  const identity = candidate.identity
  const relationship = candidate.operatorRelationship
  assertObject(identity)
  assertObject(relationship)
  relationship.knotOwnerAddress = identity.ownerAddress
  assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)

  const caseDrift = evidence()
  const caseDriftCandidate = firstCandidate(caseDrift)
  const caseDriftIdentity = caseDriftCandidate.identity
  const caseDriftRelationship = caseDriftCandidate.operatorRelationship
  assertObject(caseDriftIdentity)
  assertObject(caseDriftRelationship)
  caseDriftRelationship.knotOwnerAddress = String(caseDriftIdentity.ownerAddress).toUpperCase().replace("0X", "0x")
  assert.equal(thirdPartyAuditionReport.safeParse(caseDrift).success, false)
})

test("discovery and observation sources require credential-free HTTPS", () => {
  for (const unsafeUri of [
    "http://8004scan.io/api/v1/agents/97/2293",
    "https://user:password@8004scan.io/api/v1/agents/97/2293",
  ]) {
    const report = evidence()
    const scope = report.scope
    assertObject(scope)
    scope.discoveryRequestUri = unsafeUri
    assert.equal(thirdPartyAuditionReport.safeParse(report).success, false)

    const stageReport = evidence()
    const registered = stages(stageReport).registered
    assertObject(registered)
    registered.sourceUri = unsafeUri
    assert.equal(thirdPartyAuditionReport.safeParse(stageReport).success, false)
  }
})

test("closed evidence refuses unknown proof fields and flattering summary edits", () => {
  const unknown = evidence()
  firstCandidate(unknown).paidJobCount = 1
  assert.equal(thirdPartyAuditionReport.safeParse(unknown).success, false)

  const flattering = evidence()
  const summary = flattering.summary
  assertObject(summary)
  summary.hireableCount = 1
  assert.throws(() => verifyThirdPartyAudition(flattering), ThirdPartyAuditionError)
})
