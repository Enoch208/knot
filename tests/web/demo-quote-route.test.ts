import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { POST } from "../../apps/web/app/api/demo/quote/route.ts"

const realFetch = globalThis.fetch
const token = "q".repeat(48)
let taskId = ""
let calls: Array<{ url: string; body: Record<string, unknown> }> = []

const quoteBody = () => ({
  stage: "VERIFIED_PRE_FUNDING",
  id: `vq_${taskId}`,
  fundingPermitted: false,
  taskId,
  providerAgentId: "2295",
  expiresAtUnix: String(Math.floor(Date.now() / 1000) + 900),
  expired: false,
  verifiedAt: new Date().toISOString(),
  negotiationHash: `0x${"1".repeat(64)}`,
  requestHash: `0x${"2".repeat(64)}`,
  responseHash: `0x${"3".repeat(64)}`,
  identity: {
    chainId: 97,
    registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    agentId: "2295",
    owner: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
    blockNumber: "130000000",
    blockHash: `0x${"4".repeat(64)}`,
    observedAt: new Date().toISOString(),
  },
  quote: {
    response: {
      terms: {
        price: "100000000000000000",
        currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
        deliverables: "One task-bound analysis artifact.",
        quality_standards: "Schema-valid and snapshot-bound.",
      },
    },
  },
})

beforeEach(() => {
  taskId = ""
  calls = []
  process.env.KNOT_API_AUTH_TOKEN = token
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(input), body })
    if (String(input).endsWith("/api/tasks")) taskId = (body.task as Record<string, unknown>).taskId as string
    return Response.json(String(input).endsWith("/verified-quotes") ? quoteBody() : {}, { status: 201 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.KNOT_API_AUTH_TOKEN
})

describe("four-category public quote route", () => {
  for (const [agentSlug, agentName, endpoint] of [
    ["healthguard", "HealthGuard", "https://knot-health.truematchx.com"],
    ["rangepilot", "RangePilot", "https://knot-range.truematchx.com"],
    ["gridquant", "GridQuant", "https://knot-grid.truematchx.com"],
    ["yieldscout", "YieldScout", "https://knot-yield.truematchx.com"],
  ] as const) {
    it(`routes ${agentName} through its own authenticated seller`, async () => {
      const response = await POST(new Request("https://knotmarkets.xyz/api/demo/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentSlug, targetRangeWidthTicks: 1200, maximumSlippageBps: 50 }),
      }))
      const body = await response.json() as Record<string, unknown>
      assert.equal(response.status, 200)
      assert.equal((body.agent as Record<string, unknown>).name, agentName)
      assert.equal(body.stage, "VERIFIED_PRE_FUNDING")
      assert.equal((body.boundary as Record<string, unknown>).chainWritePerformed, false)
      assert.equal((calls[1]?.body as Record<string, unknown>).endpoint, endpoint)
      assert.equal(calls.length, 3)
    })
  }

  it("rejects unknown agents without contacting the backend", async () => {
    const response = await POST(new Request("https://knotmarkets.xyz/api/demo/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentSlug: "unknown" }),
    }))
    assert.equal(response.status, 400)
    assert.equal(calls.length, 0)
  })
})
