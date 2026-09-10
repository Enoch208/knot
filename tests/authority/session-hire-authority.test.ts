import assert from "node:assert/strict"
import { test } from "node:test"
import { slice, toFunctionSelector, zeroAddress } from "viem"
import {
  MAXIMUM_RELAY_FEE_ALLOWANCE_WEI,
  SessionHireAuthorityError,
  deriveSessionHireAuthority,
} from "../../packages/authority/src/index.ts"
import { prepareHireEnvelope } from "../../packages/commerce/src/hire-envelope.ts"
import {
  BUYER,
  PAYMENT_TOKEN,
  RANGEPILOT_PRICE_BASE_UNITS,
  RANGEPILOT_PROVIDER,
  ROUTER,
  NOW,
  baseOptions,
  rangePilotHire,
  refusalCode,
  verifiedCompatibility,
} from "./hire-fixtures.ts"

test("a 0.1 U RangePilot hire derives exactly the five prepared selectors and nothing else", () => {
  const prepared = rangePilotHire()
  const authority = deriveSessionHireAuthority(verifiedCompatibility(), prepared, baseOptions())

  const derived = [...authority.allowedCalls].map((call) => `${call.target}:${call.selector}`).sort()
  const observed = [...new Set(prepared.calls.map((call) => `${call.to}:${slice(call.data, 0, 4)}`))].sort()

  assert.equal(prepared.calls.length, 5)
  assert.equal(authority.allowedCalls.length, 5)
  assert.deepEqual(derived, observed)
  assert.deepEqual(
    authority.allowedCalls.map((call) => call.selector),
    [
      toFunctionSelector("createJob(address,address,uint256,string,address)"),
      toFunctionSelector("registerJob(uint256,address)"),
      toFunctionSelector("setBudget(uint256,uint256,bytes)"),
      toFunctionSelector("approve(address,uint256)"),
      toFunctionSelector("fund(uint256,uint256,bytes)"),
    ],
  )
  assert.deepEqual(
    authority.allowedCalls.map((call) => call.role),
    ["commerce", "router", "commerce", "paymentToken", "commerce"],
  )
})

test("the granted permission list carries one entry per prepared selector and no wildcard", () => {
  const authority = deriveSessionHireAuthority(verifiedCompatibility(), rangePilotHire(), baseOptions())

  assert.equal(authority.permissions.calls.length, authority.allowedCalls.length)
  for (const permission of authority.permissions.calls) {
    assert.match(permission.signature, /^0x[0-9a-f]{8}$/)
    assert.notEqual(permission.signature, "0x32323232")
    assert.notEqual(permission.to.toLowerCase(), "0x3232323232323232323232323232323232323232")
  }
})

test("the token cap equals the hire budget and the native limit stays a relay-fee allowance", () => {
  const authority = deriveSessionHireAuthority(verifiedCompatibility(), rangePilotHire(), baseOptions())

  assert.equal(authority.tokenSpend.token, PAYMENT_TOKEN)
  assert.equal(authority.tokenSpend.limitBaseUnits, RANGEPILOT_PRICE_BASE_UNITS)
  assert.equal(authority.nativeSpend.token, zeroAddress)
  assert.equal(authority.nativeSpend.limitBaseUnits, MAXIMUM_RELAY_FEE_ALLOWANCE_WEI.toString())
  assert.equal(authority.permissions.spend.length, 2)
  assert.deepEqual(authority.permissions.spend[0], {
    limit: BigInt(RANGEPILOT_PRICE_BASE_UNITS),
    period: authority.spendWindow.period,
    token: PAYMENT_TOKEN,
  })
  assert.deepEqual(authority.permissions.spend[1], {
    limit: MAXIMUM_RELAY_FEE_ALLOWANCE_WEI,
    period: authority.spendWindow.period,
  })
})

test("the session expiry never outlives the job and its cap cannot refresh mid-session", () => {
  const prepared = rangePilotHire()
  const authority = deriveSessionHireAuthority(verifiedCompatibility(), prepared, baseOptions())

  assert.equal(authority.expiryUnix, prepared.envelope.expiredAtUnix)
  assert.equal(authority.jobExpiredAtUnix, prepared.envelope.expiredAtUnix)
  assert.ok(authority.expiryUnix > NOW)
  assert.ok(authority.spendWindow.periodStartUnix <= NOW)
  assert.ok(authority.spendWindow.periodEndUnix > authority.expiryUnix)
})

test("a token cap above the hire budget is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      options: { ...baseOptions(), tokenCapBaseUnits: BigInt(RANGEPILOT_PRICE_BASE_UNITS) + 1n },
    })),
    "TOKEN_CAP_EXCEEDS_BUDGET",
  )
})

test("a token cap below the hire budget is refused rather than silently under-funding", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      options: { ...baseOptions(), tokenCapBaseUnits: BigInt(RANGEPILOT_PRICE_BASE_UNITS) - 1n },
    })),
    "TOKEN_CAP_BELOW_BUDGET",
  )
})

test("a session expiry that outlives the job expiry is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      options: { ...baseOptions(), expiryUnix: prepared.envelope.expiredAtUnix + 1 },
    })),
    "EXPIRY_OUTLIVES_JOB",
  )
})

test("a session expiry that is already past is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({ prepared, options: { ...baseOptions(), expiryUnix: NOW } })),
    "EXPIRY_NOT_FUTURE",
  )
})

test("a hire whose job already expired cannot scope a session at all", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      options: { nowUnix: prepared.envelope.expiredAtUnix },
    })),
    "JOB_ALREADY_EXPIRED",
  )
})

test("a relay-fee allowance above the proven ceiling or at zero is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      options: { ...baseOptions(), relayFeeAllowanceWei: MAXIMUM_RELAY_FEE_ALLOWANCE_WEI + 1n },
    })),
    "RELAY_ALLOWANCE_ABOVE_CEILING",
  )
  assert.equal(
    refusalCode((prepared) => ({ prepared, options: { ...baseOptions(), relayFeeAllowanceWei: 0n } })),
    "RELAY_ALLOWANCE_NOT_POSITIVE",
  )
})

test("a session whose window would refresh the cap mid-flight is refused", () => {
  const mondayNewYear2029 = 1_861_920_000
  const nowUnix = mondayNewYear2029 - 60
  const prepared = prepareHireEnvelope(verifiedCompatibility(), {
    jobId: 1189n,
    provider: RANGEPILOT_PROVIDER,
    buyer: BUYER,
    description: "KNOT verified hire: RangePilot LP range analysis",
    priceUnits: RANGEPILOT_PRICE_BASE_UNITS,
    currency: PAYMENT_TOKEN,
    quoteExpiresAtUnix: nowUnix + 600,
    nowUnix,
  })
  assert.ok(prepared.envelope.expiredAtUnix > mondayNewYear2029)

  try {
    deriveSessionHireAuthority(verifiedCompatibility(), prepared, { nowUnix })
  } catch (error) {
    assert.ok(error instanceof SessionHireAuthorityError)
    assert.equal(error.code, "SPEND_WINDOW_UNBOUNDED")
    return
  }
  assert.fail("a session straddling every period boundary was expected to refuse")
})

test("an unverified commerce observation refuses to scope a spending session", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      compatibility: {
        ...verifiedCompatibility(),
        status: "UNRESOLVED",
        writeAllowed: false,
        selectedPolicy: null,
        reasons: ["router is paused"],
      },
    })),
    "COMMERCE_NOT_VERIFIED",
  )
})

test("a verified observation naming a different policy than the envelope is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared,
      compatibility: { ...verifiedCompatibility(), selectedPolicy: ROUTER },
    })),
    "POLICY_NOT_SELECTED",
  )
})
