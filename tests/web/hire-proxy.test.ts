import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { POST } from "../../apps/web/app/api/hires/prepare/route.ts"

const token = "b".repeat(48)
const origin = "https://knotmarkets.xyz"
const quoteId = "vq_01JKNOTDEMO0000000000000"
const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"

interface UpstreamAttempt {
  url: string
  headers: Record<string, string>
  method: string
}

const envelope = () => ({
  chainId: 97,
  jobId: "412903118884421",
  buyer: "0x71b1373FCDffBd669b85d39B2CFB37fFB9C62930",
  provider: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
  descriptionSha256Source: "KNOT verified hire: RangePilot LP range analysis",
  budgetBaseUnits: "100000000000000000",
  paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
  policy: POLICY,
  disputeWindowSeconds: 900,
  expiredAtUnix: 1_788_000_000,
  quoteExpiresAtUnix: 1_787_990_000,
  callCount: 2,
})

const preparation = () => ({
  envelope: envelope(),
  calls: [
    { to: POLICY, data: "0xab", value: "0" },
    { to: POLICY, data: "0xcd", value: "0" },
  ],
  verifiedQuoteId: quoteId,
  observedAtUtc: "2026-09-10T00:00:00.000Z",
  blockNumber: "130000000",
})

let attempts: UpstreamAttempt[] = []
const realFetch = globalThis.fetch

const stubUpstream = (status: number, body: unknown): void => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    attempts.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      method: init?.method ?? "GET",
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

const hireRequest = (
  overrides: { headers?: Record<string, string>; body?: string } = {},
): Request =>
  new Request("https://knotmarkets.xyz/api/hires/prepare", {
    method: "POST",
    headers: overrides.headers ?? {
      "content-type": "application/json",
      origin,
      "idempotency-key": quoteId,
    },
    body: overrides.body ?? JSON.stringify({ verifiedQuoteId: quoteId }),
  })

const readBody = async (response: Response): Promise<Record<string, unknown>> =>
  await response.json() as Record<string, unknown>

beforeEach(() => {
  attempts = []
  process.env.KNOT_API_AUTH_TOKEN = token
  stubUpstream(200, preparation())
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.KNOT_API_AUTH_TOKEN
})

describe("hire preparation proxy", () => {
  it("returns the reviewable envelope and calls for a prepared hire", async () => {
    const response = await POST(hireRequest())
    assert.equal(response.status, 200)
    const body = await readBody(response)
    const returned = body.envelope as Record<string, unknown>
    assert.equal(returned.budgetBaseUnits, "100000000000000000")
    assert.equal(returned.policy, POLICY)
    assert.equal(returned.disputeWindowSeconds, 900)
    assert.equal((body.calls as unknown[]).length, 2)
    assert.equal(body.verifiedQuoteId, quoteId)
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0")
  })

  it("binds the upstream call to the quote identifier without exposing the token", async () => {
    const response = await POST(hireRequest())
    const attempt = attempts[0]
    assert.ok(attempt)
    assert.equal(attempt.method, "POST")
    assert.match(attempt.url, /\/api\/verified-quotes\/vq_01JKNOTDEMO0000000000000\/hire-preparation$/)
    assert.equal(attempt.headers["idempotency-key"], quoteId)
    assert.equal(attempt.headers.origin, origin)
    assert.equal(attempt.headers.authorization, `Bearer ${token}`)
    assert.doesNotMatch(await response.text(), new RegExp(token))
  })

  it("refuses a cross-origin preparation attempt without contacting upstream", async () => {
    const response = await POST(
      hireRequest({
        headers: { "content-type": "application/json", origin: "https://evil.example", "idempotency-key": quoteId },
      }),
    )
    assert.equal(response.status, 403)
    assert.equal((await readBody(response)).code, "AUTHORITY_MISMATCH")
    assert.equal(attempts.length, 0)
  })

  it("refuses a preparation attempt that carries no origin header", async () => {
    const response = await POST(
      hireRequest({ headers: { "content-type": "application/json", "idempotency-key": quoteId } }),
    )
    assert.equal(response.status, 403)
    assert.equal(attempts.length, 0)
  })

  it("refuses an oversized body before parsing it", async () => {
    const response = await POST(
      hireRequest({ body: JSON.stringify({ verifiedQuoteId: quoteId, filler: "x".repeat(2048) }) }),
    )
    assert.equal(response.status, 413)
    assert.equal(attempts.length, 0)
  })

  it("refuses a request with no idempotency key", async () => {
    const response = await POST(hireRequest({ headers: { "content-type": "application/json", origin } }))
    assert.equal(response.status, 400)
    assert.equal(attempts.length, 0)
  })

  it("refuses an idempotency key that does not equal the verified quote identifier", async () => {
    const response = await POST(
      hireRequest({
        headers: { "content-type": "application/json", origin, "idempotency-key": "vq_other" },
      }),
    )
    assert.equal(response.status, 400)
    assert.equal(attempts.length, 0)
  })

  it("refuses an identifier that is not a bare resource identifier", async () => {
    const traversal = "../../secrets"
    const response = await POST(
      hireRequest({
        headers: { "content-type": "application/json", origin, "idempotency-key": traversal },
        body: JSON.stringify({ verifiedQuoteId: traversal }),
      }),
    )
    assert.equal(response.status, 400)
    assert.equal(attempts.length, 0)
  })

  it("refuses a body carrying fields beyond the verified quote identifier", async () => {
    const response = await POST(
      hireRequest({ body: JSON.stringify({ verifiedQuoteId: quoteId, budgetBaseUnits: "1" }) }),
    )
    assert.equal(response.status, 400)
    assert.equal(attempts.length, 0)
  })

  it("preserves an upstream 503 when commerce writes are suspended", async () => {
    stubUpstream(503, {
      code: "UPSTREAM_UNAVAILABLE",
      explanation: "Commerce writes are suspended: policy conflict",
      retryable: true,
    })
    const response = await POST(hireRequest())
    assert.equal(response.status, 503)
    const body = await readBody(response)
    assert.equal(body.code, "UPSTREAM_UNAVAILABLE")
    assert.match(String(body.explanation), /suspended/)
    assert.equal(body.retryable, true)
    assert.equal(body.financialState, "unfunded")
  })

  it("preserves an upstream 409 when the envelope is refused", async () => {
    stubUpstream(409, {
      code: "CONFLICT",
      explanation: "Hire preparation refused: QUOTE_EXPIRED",
      retryable: false,
    })
    const response = await POST(hireRequest())
    assert.equal(response.status, 409)
    const body = await readBody(response)
    assert.equal(body.code, "CONFLICT")
    assert.match(String(body.explanation), /QUOTE_EXPIRED/)
    assert.equal(body.retryable, false)
  })

  it("preserves an upstream 404 for a quote that does not exist", async () => {
    stubUpstream(404, { code: "RESOURCE_NOT_FOUND", explanation: "No verified quote matches that identifier.", retryable: false })
    const response = await POST(hireRequest())
    assert.equal(response.status, 404)
    assert.equal((await readBody(response)).code, "RESOURCE_NOT_FOUND")
  })

  it("does not surface an upstream credential refusal as a browser authorization failure", async () => {
    stubUpstream(401, { code: "AUTHORITY_MISMATCH", explanation: "Valid API authorization is required.", retryable: false })
    const response = await POST(hireRequest())
    assert.equal(response.status, 503)
    assert.equal((await readBody(response)).code, "UPSTREAM_UNAVAILABLE")
  })

  it("refuses to serve a preparation whose call count contradicts its envelope", async () => {
    const tampered = preparation()
    tampered.calls = [{ to: POLICY, data: "0xab", value: "0" }]
    stubUpstream(200, tampered)
    const response = await POST(hireRequest())
    assert.equal(response.status, 502)
    assert.equal((await readBody(response)).code, "RESULT_INCOMPLETE")
  })

  it("refuses to serve a preparation bound to a different verified quote", async () => {
    const tampered = preparation()
    tampered.verifiedQuoteId = "vq_someone_else"
    stubUpstream(200, tampered)
    const response = await POST(hireRequest())
    assert.equal(response.status, 502)
  })

  it("refuses to serve a preparation that is not bound to BSC testnet", async () => {
    const tampered = preparation()
    tampered.envelope.chainId = 56
    stubUpstream(200, tampered)
    const response = await POST(hireRequest())
    assert.equal(response.status, 502)
  })

  it("refuses to prepare when the deployment carries no upstream credential", async () => {
    delete process.env.KNOT_API_AUTH_TOKEN
    const response = await POST(hireRequest())
    assert.equal(response.status, 503)
    assert.equal(attempts.length, 0)
  })
})
