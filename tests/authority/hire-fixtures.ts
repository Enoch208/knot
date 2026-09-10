import assert from "node:assert/strict"
import {
  SessionHireAuthorityError,
  deriveSessionHireAuthority,
  type SessionHireAuthorityOptions,
} from "../../packages/authority/src/index.ts"
import type { CommerceCompatibility } from "../../packages/commerce/src/compatibility.ts"
import { prepareHireEnvelope, type PreparedCall, type PreparedHire } from "../../packages/commerce/src/hire-envelope.ts"

export const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"
export const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE"
export const ROUTER = "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25"
export const PAYMENT_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
export const RANGEPILOT_PROVIDER = "0xE4feD886b4b9062486d4663c6962E14473Bd7320"
export const BUYER = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
export const UNLISTED_CONTRACT = "0xcb5CEf3C54aa90e9A7ad602A258D3d360cC862B9"
export const RANGEPILOT_PRICE_BASE_UNITS = "100000000000000000"
export const NOW = 1_760_000_000

export const verifiedCompatibility = (): CommerceCompatibility => ({
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

export const rangePilotHire = (): PreparedHire =>
  prepareHireEnvelope(verifiedCompatibility(), {
    jobId: 1189n,
    provider: RANGEPILOT_PROVIDER,
    buyer: BUYER,
    description: "KNOT verified hire: RangePilot LP range analysis",
    priceUnits: RANGEPILOT_PRICE_BASE_UNITS,
    currency: PAYMENT_TOKEN,
    quoteExpiresAtUnix: NOW + 600,
    nowUnix: NOW,
  })

export const baseOptions = (): SessionHireAuthorityOptions => ({ nowUnix: NOW })

export const replaceCall = (prepared: PreparedHire, index: number, call: PreparedCall): PreparedHire => ({
  envelope: prepared.envelope,
  calls: prepared.calls.map((existing, position) => (position === index ? call : existing)),
})

export const callAt = (prepared: PreparedHire, index: number): PreparedCall => {
  const call = prepared.calls[index]
  assert.ok(call, `prepared hire has no call at index ${index}`)
  return call
}

export interface RefusalScenario {
  prepared: PreparedHire
  compatibility?: CommerceCompatibility
  options?: SessionHireAuthorityOptions
}

export const refusalCode = (mutate: (prepared: PreparedHire) => RefusalScenario): string => {
  const scenario = mutate(rangePilotHire())
  try {
    deriveSessionHireAuthority(
      scenario.compatibility ?? verifiedCompatibility(),
      scenario.prepared,
      scenario.options ?? baseOptions(),
    )
  } catch (error) {
    assert.ok(
      error instanceof SessionHireAuthorityError,
      `expected SessionHireAuthorityError, received ${String(error)}`,
    )
    return error.code
  }
  return assert.fail("the derivation was expected to refuse but produced an authority")
}
