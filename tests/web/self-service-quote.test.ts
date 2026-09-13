import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import { POST } from "../../apps/web/app/api/self-service/quote/route.ts"
import { prepareServiceRequest, type ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"

const origin = "https://knotmarkets.xyz"
const token = "s".repeat(48)
const buyer = privateKeyToAccount(`0x${"33".repeat(32)}`)
const realFetch = globalThis.fetch
let attempts: Array<{ url: string; init: RequestInit }> = []

const post = (body: unknown) => POST(new Request(`${origin}/api/self-service/quote`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(body),
}))

const read = async (response: Response) => await response.json() as Record<string, unknown>

beforeEach(() => {
  attempts = []
  process.env.KNOT_API_AUTH_TOKEN = token
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    attempts.push({ url: String(input), init: init ?? {} })
    const body = JSON.parse(String(init?.body)) as {
      task: { taskId: string }
      serviceRequest: { id: string }
    }
    return Response.json({
      stage: "VERIFIED_PRE_FUNDING",
      id: body.serviceRequest.id,
      serviceRequestId: body.serviceRequest.id,
      buyer: buyer.address,
      fundingPermitted: false,
      taskId: body.task.taskId,
      providerAgentId: "owned_healthguard_2295",
      expiresAtUnix: String(Math.floor(Date.now() / 1_000) + 600),
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
      quote: { response: { terms: {
        price: "100000000000000000",
        currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
        deliverables: "One task-bound analysis artifact.",
        quality_standards: "Schema-valid and snapshot-bound.",
      } } },
      lifecycle: { taskStatus: 201, serviceRequestStatus: 201, quoteStatus: 201 },
    }, { status: 201 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.KNOT_API_AUTH_TOKEN
})

describe("buyer-bound quote proxy", () => {
  it("builds all four seller requests with the recovered buyer authority", async () => {
    for (const agentSlug of ["healthguard", "rangepilot", "gridquant", "yieldscout"] as const) {
      const response = await post({
        stage: "DRAFT",
        buyer: buyer.address,
        agentSlug,
        targetRangeWidthTicks: 1200,
        maximumSlippageBps: 50,
      })
      assert.equal(response.status, 200)
      const draft = await read(response)
      assert.equal(draft.stage, "SIGN_BUYER_INTENT")
      assert.equal(draft.accountType, "EOA")
      const body = JSON.parse(Buffer.from(String(draft.requestBodyBase64url), "base64url").toString("utf8")) as {
        serviceRequest: { id: string; envelope: ServiceRequestEnvelope }
      }
      const prepared = prepareServiceRequest(body.serviceRequest.envelope, buyer.address)
      assert.equal(prepared.buyer.toLowerCase(), buyer.address.toLowerCase())
      assert.match(body.serviceRequest.id, new RegExp(`^ss_${buyer.address.slice(2).toLowerCase()}_`))
      const sellerRequest = JSON.parse(Buffer.from(body.serviceRequest.envelope.request.bytesBase64url, "base64url").toString("utf8")) as Record<string, unknown>
      if (agentSlug === "gridquant") {
        const retainedRequester = (sellerRequest.task as Record<string, unknown>).requester
        assert.equal(retainedRequester, "0x71b1373fcdffbd669b85d39b2cfb37ffb9c62930")
        assert.equal((sellerRequest.snapshot as Record<string, unknown>).requester, retainedRequester)
      }
      if (agentSlug === "yieldscout") {
        assert.equal(sellerRequest.requester, "0x71b1373fcdffbd669b85d39b2cfb37ffb9c62930")
      }
    }
    assert.equal(attempts.length, 0)
  })

  it("forwards the byte-exact signed body once and validates the returned buyer", async () => {
    const options = { agentSlug: "healthguard" as const, targetRangeWidthTicks: 1200, maximumSlippageBps: 50 }
    const draft = await read(await post({ stage: "DRAFT", buyer: buyer.address, ...options }))
    const signature = await buyer.signMessage({ message: String(draft.message) })
    const response = await post({
      stage: "EXECUTE",
      ...options,
      buyerIntent: draft.buyerIntent,
      buyerSignature: signature,
      requestBodyBase64url: draft.requestBodyBase64url,
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const result = await read(response)
    assert.equal((result.buyerBinding as Record<string, unknown>).buyer, buyer.address)
    assert.equal((result.boundary as Record<string, unknown>).chainWritePerformed, false)
    assert.equal(attempts.length, 1)
    const attempt = attempts[0]!
    assert.match(attempt.url, /\/api\/self-service\/verified-quotes$/)
    const headers = attempt.init.headers as Record<string, string>
    assert.equal(headers["x-knot-buyer-signature"], signature)
    assert.equal(headers.authorization, `Bearer ${token}`)
    assert.equal(String(attempt.init.body), Buffer.from(String(draft.requestBodyBase64url), "base64url").toString("utf8"))
  })

  it("does not let changed options reuse a signed draft", async () => {
    const draft = await read(await post({
      stage: "DRAFT",
      buyer: buyer.address,
      agentSlug: "rangepilot",
      targetRangeWidthTicks: 1200,
      maximumSlippageBps: 50,
    }))
    const signature = await buyer.signMessage({ message: String(draft.message) })
    const response = await post({
      stage: "EXECUTE",
      agentSlug: "rangepilot",
      targetRangeWidthTicks: 2400,
      maximumSlippageBps: 50,
      buyerIntent: draft.buyerIntent,
      buyerSignature: signature,
      requestBodyBase64url: draft.requestBodyBase64url,
    })
    assert.equal(response.status, 401)
    assert.equal(attempts.length, 0)
  })
})
