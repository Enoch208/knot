import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createApiHandler } from "../../apps/api/src/app.ts"
import type { ApiConfig, ApiRequest, ApiStore } from "../../apps/api/src/types.ts"
import type { CommerceCompatibility } from "../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../packages/db/src/index.ts"

const token = "a".repeat(48)
const buyer = "0x71b1373fcdffbd669b85d39b2cfb37ffb9c62930"
const origin = "https://knotmarkets.xyz"
const quoteId = "vq_01JKNOTDEMO0000000000000"
const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"

const compatibility = (overrides: Partial<CommerceCompatibility> = {}): CommerceCompatibility => ({
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
      commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
      router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25",
      disputeWindowSeconds: "900",
      compatible: true,
    },
  ],
  ...overrides,
})

const quoteRecord = (): VerifiedQuoteRecord =>
  ({
    id: quoteId,
    buyer,
    sellerOwner: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
    canonicalJobDescription: "KNOT verified hire: RangePilot LP range analysis",
    quote: {
      response: {
        terms: { price: "100000000000000000", currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" },
        quote_expires_at: Math.floor(Date.parse("2026-09-09T12:10:00Z") / 1000),
      },
    },
  }) as unknown as VerifiedQuoteRecord

const store = (record: VerifiedQuoteRecord | null): ApiStore =>
  ({
    async status() {},
    async getVerifiedQuote() {
      return record
    },
  }) as unknown as ApiStore

const config = (probe?: () => Promise<CommerceCompatibility>): ApiConfig => ({
  authToken: token,
  buyerAddress: buyer,
  allowedOrigin: origin,
  maxBodyBytes: 65_536,
  now: () => new Date("2026-09-09T12:00:00Z"),
  ...(probe ? { commerceProbe: probe } : {}),
})

const hireRequest = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: "POST",
  path: `/api/verified-quotes/${quoteId}/hire-preparation`,
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin,
    "idempotency-key": quoteId,
  },
  body: "{}",
  ...overrides,
})

describe("hire preparation route", () => {
  it("returns a reviewable envelope and calls for a live verified quote", async () => {
    const response = await createApiHandler(
      store(quoteRecord()),
      config(async () => compatibility()),
    )(hireRequest())
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body) as {
      envelope: { budgetBaseUnits: string; policy: string; disputeWindowSeconds: number }
      calls: unknown[]
    }
    assert.equal(body.envelope.budgetBaseUnits, "100000000000000000")
    assert.equal(body.envelope.policy, POLICY)
    assert.equal(body.envelope.disputeWindowSeconds, 900)
    assert.equal(body.calls.length, 5)
  })

  it("refuses when the deployment has no commerce probe configured", async () => {
    const response = await createApiHandler(store(quoteRecord()), config())(hireRequest())
    assert.equal(response.status, 503)
  })

  it("refuses with 503 when commerce writes are suspended", async () => {
    const response = await createApiHandler(
      store(quoteRecord()),
      config(async () => compatibility({ status: "UNRESOLVED", writeAllowed: false, reasons: ["policy conflict"] })),
    )(hireRequest())
    assert.equal(response.status, 503)
    assert.match(response.body, /suspended/)
  })

  it("returns 404 for a quote that does not belong to the configured buyer", async () => {
    const response = await createApiHandler(
      store(null),
      config(async () => compatibility()),
    )(hireRequest())
    assert.equal(response.status, 404)
  })

  it("rejects a mismatched idempotency key", async () => {
    const response = await createApiHandler(
      store(quoteRecord()),
      config(async () => compatibility()),
    )(hireRequest({ headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin, "idempotency-key": "other" } }))
    assert.equal(response.status, 400)
  })

  it("rejects an unauthenticated preparation attempt", async () => {
    const response = await createApiHandler(
      store(quoteRecord()),
      config(async () => compatibility()),
    )(hireRequest({ headers: { "content-type": "application/json", origin, "idempotency-key": quoteId } }))
    assert.equal(response.status, 401)
  })

  it("rejects a cross-origin preparation attempt", async () => {
    const response = await createApiHandler(
      store(quoteRecord()),
      config(async () => compatibility()),
    )(hireRequest({ headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.example", "idempotency-key": quoteId } }))
    assert.ok(response.status === 403 || response.status === 400, `expected refusal, received ${response.status}`)
  })
})
