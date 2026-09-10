import assert from "node:assert/strict"
import { test } from "node:test"
import {
  deriveJobId,
  prepareHireForVerifiedQuote,
  HirePreparationUnavailableError,
} from "../../apps/api/src/hire-preparation.ts"
import type { CommerceCompatibility } from "../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../packages/db/src/index.ts"

const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"
const NOW = 1_760_000_000

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

const record = (): VerifiedQuoteRecord =>
  ({
    id: "vq_01JKNOTDEMO0000000000000",
    buyer: "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930",
    sellerOwner: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
    canonicalJobDescription: "KNOT verified hire: RangePilot LP range analysis",
    quote: {
      response: {
        terms: {
          price: "100000000000000000",
          currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
        },
        quote_expires_at: NOW + 600,
      },
    },
  }) as unknown as VerifiedQuoteRecord

test("a verified quote prepares a hire bound to the live commerce observation", async () => {
  const prepared = await prepareHireForVerifiedQuote(async () => compatibility(), {
    record: record(),
    nowUnix: NOW,
  })
  assert.equal(prepared.verifiedQuoteId, "vq_01JKNOTDEMO0000000000000")
  assert.equal(prepared.blockNumber, "130000000")
  assert.equal(prepared.envelope.budgetBaseUnits, "100000000000000000")
  assert.equal(prepared.calls.length, 5)
})

test("the job id is deterministic so a retried preparation cannot create a second on-chain job", () => {
  const first = deriveJobId("vq_01JKNOTDEMO0000000000000")
  const second = deriveJobId("vq_01JKNOTDEMO0000000000000")
  assert.equal(first, second)
  assert.notEqual(first, deriveJobId("vq_01JKNOTDEMO0000000000001"))
  assert.ok(first > 0n, "job id must be positive")
})

test("suspended commerce writes refuse preparation and surface the reason", async () => {
  await assert.rejects(
    prepareHireForVerifiedQuote(
      async () => compatibility({ status: "UNRESOLVED", writeAllowed: false, reasons: ["policy conflict"] }),
      { record: record(), nowUnix: NOW },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HirePreparationUnavailableError)
      assert.deepEqual(error.reasons, ["policy conflict"])
      return true
    },
  )
})

test("a verified status with writes disallowed still refuses", async () => {
  await assert.rejects(
    prepareHireForVerifiedQuote(async () => compatibility({ writeAllowed: false }), {
      record: record(),
      nowUnix: NOW,
    }),
    HirePreparationUnavailableError,
  )
})

test("a probe failure propagates instead of silently preparing a hire", async () => {
  await assert.rejects(
    prepareHireForVerifiedQuote(
      async () => {
        throw new Error("rpc unreachable")
      },
      { record: record(), nowUnix: NOW },
    ),
    /rpc unreachable/,
  )
})

test("an expired quote is refused at preparation time, not at signing time", async () => {
  await assert.rejects(
    prepareHireForVerifiedQuote(async () => compatibility(), {
      record: record(),
      nowUnix: NOW + 601,
    }),
    /QUOTE_EXPIRED|expired/,
  )
})
