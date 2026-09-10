import assert from "node:assert/strict"
import { test } from "node:test"
import {
  compareCandidates,
  type Candidate,
} from "../../packages/comparison/src/task-comparison.ts"

const NOW = 1_760_000_000
const U = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  key: "rangepilot",
  displayName: "RangePilot",
  category: "rebalancing",
  operatorRelationship: "KNOT_OPERATED",
  availability: "CALLABLE",
  priceBaseUnits: "100000000000000000",
  currency: U,
  quoteExpiresAtUnix: NOW + 600,
  completedJobs: 1,
  refundedJobs: 0,
  evidenceClass: "testnet_observation",
  ...overrides,
})

test("a category mismatch is excluded with a stated reason rather than silently dropped", () => {
  const result = compareCandidates([candidate({ category: "health" })], "rebalancing", NOW)
  assert.equal(result.outcome, "NO_COMPATIBLE_CANDIDATE")
  assert.equal(result.rows[0]?.eligible, false)
  assert.equal(result.rows[0]?.exclusionReason, "does not support this task category")
})

test("a registered but non-callable agent is never treated as hireable", () => {
  const result = compareCandidates([candidate({ availability: "REGISTERED_ONLY" })], "rebalancing", NOW)
  assert.equal(result.rows[0]?.eligible, false)
  assert.match(result.rows[0]?.exclusionReason ?? "", /not callable/)
})

test("an expired quote is excluded at comparison time", () => {
  const result = compareCandidates([candidate({ quoteExpiresAtUnix: NOW - 1 })], "rebalancing", NOW)
  assert.match(result.rows[0]?.exclusionReason ?? "", /expired/)
})

test("a non-integer price is excluded rather than parsed loosely", () => {
  const result = compareCandidates([candidate({ priceBaseUnits: "0.1" })], "rebalancing", NOW)
  assert.match(result.rows[0]?.exclusionReason ?? "", /integer base units/)
})

test("one eligible candidate is reported as a single candidate, not as a winner", () => {
  const result = compareCandidates(
    [candidate(), candidate({ key: "other", availability: "UNREACHABLE" })],
    "rebalancing",
    NOW,
  )
  assert.equal(result.outcome, "SINGLE_CANDIDATE")
  assert.equal(result.decisiveDimension, null)
  assert.ok(result.limitations.some((line) => /not a comparison/.test(line)))
})

test("equal prices are reported as a tie with no recommendation", () => {
  const result = compareCandidates(
    [candidate(), candidate({ key: "gridquant", displayName: "GridQuant" })],
    "rebalancing",
    NOW,
  )
  assert.equal(result.outcome, "TIE")
  assert.equal(result.recommendedKey, null)
  assert.equal(result.decisiveDimension, null)
})

test("mixed currencies are reported as not comparable rather than ranked", () => {
  const result = compareCandidates(
    [
      candidate(),
      candidate({ key: "other", currency: "0x0000000000000000000000000000000000000001", priceBaseUnits: "1" }),
    ],
    "rebalancing",
    NOW,
  )
  assert.equal(result.outcome, "NOT_COMPARABLE")
  assert.equal(result.recommendedKey, null)
  assert.ok(result.limitations.some((line) => /different currencies/.test(line)))
})

test("a decided comparison names price as the only dimension measured", () => {
  const result = compareCandidates(
    [candidate(), candidate({ key: "cheaper", priceBaseUnits: "50000000000000000" })],
    "rebalancing",
    NOW,
  )
  assert.equal(result.outcome, "DECIDED")
  assert.equal(result.recommendedKey, "cheaper")
  assert.equal(result.decisiveDimension, "price")
  assert.ok(
    result.limitations.some((line) => /does not measure delivered quality/.test(line)),
    "a decided comparison must disclose what price does not measure",
  )
})

test("an all-KNOT comparison discloses that it is not independent businesses", () => {
  const result = compareCandidates(
    [candidate(), candidate({ key: "cheaper", priceBaseUnits: "50000000000000000" })],
    "rebalancing",
    NOW,
  )
  assert.equal(result.operatorIndependence, "SAME_OPERATOR")
  assert.ok(
    result.limitations.some((line) => /not independent businesses/.test(line)),
    "invariant 4 requires the operator relationship to be stated",
  )
})

test("a KNOT agent against an external owner is reported as mixed independence", () => {
  const result = compareCandidates(
    [
      candidate(),
      candidate({
        key: "external",
        operatorRelationship: "EXTERNAL_DISTINCT_OWNER",
        priceBaseUnits: "50000000000000000",
      }),
    ],
    "rebalancing",
    NOW,
  )
  assert.equal(result.operatorIndependence, "MIXED")
  assert.equal(result.recommendedKey, "external")
})

test("every candidate appears in the rows even when excluded", () => {
  const result = compareCandidates(
    [candidate(), candidate({ key: "a", availability: "UNREACHABLE" }), candidate({ key: "b", category: "yield" })],
    "rebalancing",
    NOW,
  )
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows.filter((row) => row.eligible).length, 1)
})
