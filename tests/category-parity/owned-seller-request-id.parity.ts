import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

interface SigningBoundary {
  listPrice(): bigint
  clampPrice(price: bigint): bigint
  signQuote(request: Record<string, unknown>, price: bigint): Promise<Record<string, unknown>>
  verifySignedJob(jobId: number): Promise<{ ok: boolean; reason: string; permanent: boolean }>
  jobSpec(jobId: number): Promise<{ task: string; terms: Record<string, unknown> } | null>
  submitResult(jobId: number, response: string): Promise<{ submitTx: string; deliverableUrl: string | null }>
}

interface SellerCoreOptions {
  generator: string
  signing: SigningBoundary
  pendingJobs(): Promise<Record<string, unknown>>
  runWork(prompt: string, options: { sessionId: string; abortSignal?: AbortSignal }): Promise<string>
}

interface SellerCoreInstance {
  negotiate(data: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface SellerCoreConstructor {
  new(options: SellerCoreOptions): SellerCoreInstance
}

interface Capture {
  request: Record<string, unknown> | null
}

const sellers = ["healthguard", "rangepilot", "gridquant", "yieldscout"] as const

async function sellerCore(name: (typeof sellers)[number]): Promise<SellerCoreConstructor> {
  const path = resolve("agents", name, "app", "agent", "src", "sellerCore.ts")
  const module = await import(pathToFileURL(path).href) as { SellerCore?: unknown }
  assert.equal(typeof module.SellerCore, "function")
  return module.SellerCore as SellerCoreConstructor
}

function signingBoundary(requestId: string, capture: Capture): SigningBoundary {
  return {
    listPrice: () => 100_000_000_000_000_000n,
    clampPrice: (price) => price,
    signQuote: async (request) => {
      capture.request = request
      if (request.request_id !== requestId) throw new Error("request is not replay-bound")
      return { accepted: true, request }
    },
    verifySignedJob: async () => ({ ok: false, reason: "unused", permanent: false }),
    jobSpec: async () => null,
    submitResult: async () => ({ submitTx: "0xunused", deliverableUrl: null }),
  }
}

for (const name of sellers) {
  test(`${name} preserves only a nested negotiation request replay nonce`, async () => {
    const Core = await sellerCore(name)
    const requestId = `knot-request-${name}-001`
    const capture: Capture = { request: null }
    const core = new Core({
      generator: name,
      signing: signingBoundary(requestId, capture),
      pendingJobs: async () => ({ jobs: [] }),
      runWork: async () => "unused",
    })
    const request = {
      task_description: `knot-json-base64url/1:${name}`,
      terms: { price: "100000000000000000", currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" },
      request_id: requestId,
    }
    const response = await core.negotiate({ skill: "negotiate", request })
    assert.equal(response.accepted, true)
    assert.equal(capture.request, request)
    assert.deepEqual(capture.request, request)

    capture.request = null
    await assert.rejects(core.negotiate({ skill: "negotiate", ...request }), /not replay-bound/)
    assert.deepEqual(capture.request, {
      task_description: request.task_description,
      terms: request.terms,
    })
    assert.equal("request_id" in (capture.request ?? {}), false)
  })
}
