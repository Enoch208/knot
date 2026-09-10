import assert from "node:assert/strict"
import { test } from "node:test"
import {
  HireEnvelopeError,
  prepareHireEnvelope,
  type HireEnvelopeInput,
} from "../../packages/commerce/src/hire-envelope.ts"
import type { CommerceCompatibility } from "../../packages/commerce/src/compatibility.ts"

const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"
const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE"
const ROUTER = "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25"
const PAYMENT_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
const PROVIDER = "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389"
const BUYER = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
const NOW = 1_760_000_000

const verifiedCompatibility = (): CommerceCompatibility => ({
  status: "VERIFIED",
  writeAllowed: true,
  chainId: 97,
  blockNumber: "130000000",
  observedAtUtc: "2026-09-10T00:00:00.000Z",
  sdkVersions: null,
  selectedPolicy: POLICY,
  declarationConflict: false,
  reasons: [],
  policies: [
    {
      address: POLICY,
      declaredBy: ["@bnbagent/sdk"],
      codeHash: null,
      whitelisted: true,
      commerce: COMMERCE,
      router: ROUTER,
      disputeWindowSeconds: "900",
      compatible: true,
    },
  ],
})

const baseInput = (): HireEnvelopeInput => ({
  jobId: 4242n,
  provider: PROVIDER,
  buyer: BUYER,
  description: "KNOT verified hire: RangePilot LP range analysis",
  priceUnits: "100000000000000000",
  currency: PAYMENT_TOKEN,
  quoteExpiresAtUnix: NOW + 600,
  nowUnix: NOW,
})

const refusalCode = (input: HireEnvelopeInput, compatibility = verifiedCompatibility()): string => {
  try {
    prepareHireEnvelope(compatibility, input)
  } catch (error) {
    assert.ok(error instanceof HireEnvelopeError, `expected HireEnvelopeError, received ${String(error)}`)
    return error.code
  }
  return assert.fail("preparation was expected to fail closed but succeeded")
}

test("a verified quote produces a reviewable envelope bound to the observed policy", () => {
  const { envelope, calls } = prepareHireEnvelope(verifiedCompatibility(), baseInput())

  assert.equal(envelope.chainId, 97)
  assert.equal(envelope.jobId, "4242")
  assert.equal(envelope.budgetBaseUnits, "100000000000000000")
  assert.equal(envelope.policy, POLICY)
  assert.equal(envelope.disputeWindowSeconds, 900)
  assert.equal(envelope.paymentToken, PAYMENT_TOKEN)
  assert.ok(envelope.expiredAtUnix > NOW + envelope.disputeWindowSeconds)
  assert.equal(envelope.callCount, calls.length)
  assert.ok(calls.length > 0, "a hire must produce at least one call")
})

test("every prepared call carries a checksummed target and concrete calldata", () => {
  const { calls } = prepareHireEnvelope(verifiedCompatibility(), baseInput())
  for (const call of calls) {
    assert.match(call.to, /^0x[0-9a-fA-F]{40}$/)
    assert.match(call.data, /^0x[0-9a-f]*$/)
    assert.match(call.value, /^[0-9]+$/)
  }
})

test("an unresolved commerce observation refuses to prepare a hire", () => {
  const unresolved: CommerceCompatibility = {
    ...verifiedCompatibility(),
    status: "UNRESOLVED",
    writeAllowed: false,
    selectedPolicy: null,
    reasons: ["policy declaration conflict"],
  }
  assert.throws(() => prepareHireEnvelope(unresolved, baseInput()))
})

test("an expired signed quote is refused", () => {
  assert.equal(refusalCode({ ...baseInput(), quoteExpiresAtUnix: NOW - 1 }), "QUOTE_EXPIRED")
})

test("a currency that is not the configured payment token is refused", () => {
  assert.equal(
    refusalCode({ ...baseInput(), currency: "0x0000000000000000000000000000000000000001" }),
    "CURRENCY_MISMATCH",
  )
})

test("a decimal or non-integer price is refused rather than rounded", () => {
  assert.equal(refusalCode({ ...baseInput(), priceUnits: "0.1" }), "PRICE_NOT_BASE_UNITS")
  assert.equal(refusalCode({ ...baseInput(), priceUnits: "1e17" }), "PRICE_NOT_BASE_UNITS")
})

test("a zero price is refused because a paid hire must move value", () => {
  assert.equal(refusalCode({ ...baseInput(), priceUnits: "0" }), "PRICE_NOT_POSITIVE")
})

test("a job lifetime inside the dispute window is refused", () => {
  assert.equal(
    refusalCode({ ...baseInput(), jobLifetimeSeconds: 900 }),
    "LIFETIME_OUT_OF_RANGE",
  )
  assert.equal(
    refusalCode({ ...baseInput(), jobLifetimeSeconds: 100_000 }),
    "LIFETIME_OUT_OF_RANGE",
  )
})

test("a policy without a compatibility observation is refused", () => {
  const orphaned: CommerceCompatibility = { ...verifiedCompatibility(), policies: [] }
  assert.equal(refusalCode(baseInput(), orphaned), "POLICY_UNOBSERVED")
})

test("an unreadable dispute window refuses rather than assuming zero", () => {
  const compatibility = verifiedCompatibility()
  const [policy] = compatibility.policies
  assert.ok(policy)
  policy.disputeWindowSeconds = "unknown"
  assert.equal(refusalCode(baseInput(), compatibility), "DISPUTE_WINDOW_UNREADABLE")
})
