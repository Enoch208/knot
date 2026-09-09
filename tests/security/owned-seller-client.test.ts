import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  OwnedSellerClient,
  OwnedSellerClientError,
  SafeFetchError,
  type OwnedSellerSafeFetch,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from "../../packages/security/src/index.ts"

const descriptor = {
  key: "rangepilot",
  origin: "https://range.knot.example",
  tokenUrl: "https://range.knot.example/oauth/token",
  invocationUrl: "https://range.knot.example/",
  oauthScope: "knot:rangepilot:invoke",
}

const credentials = {
  clientId: "buyer-client",
  clientSecret: "private-client-secret",
}

const request = {
  requestId: "request-01",
  data: {
    taskDescription: "quoted-task-description",
    capability: "range-backtest",
  },
}

const token = {
  access_token: "signed.oauth.token",
  token_type: "Bearer",
  expires_in: 120,
  scope: descriptor.oauthScope,
}

const sellerMessage = (id = request.requestId, payload: Readonly<Record<string, unknown>> = { quote: "untrusted" }) => ({
  jsonrpc: "2.0",
  id,
  result: {
    kind: "message",
    role: "agent",
    messageId: "seller-message-01",
    contextId: "seller-context-01",
    taskId: "seller-task-01",
    parts: [{ kind: "data", data: payload }],
  },
})

const jsonResponse = (value: unknown, overrides: Partial<SafeFetchResponse> = {}): SafeFetchResponse => ({
  url: "https://range.knot.example/",
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify(value)),
  redirects: [],
  ...overrides,
})

const textBody = (options: SafeFetchOptions): string => {
  assert.notEqual(options.body, undefined)
  return typeof options.body === "string" ? options.body : Buffer.from(options.body!).toString("utf8")
}

const errorCode = (code: string) => (error: unknown): boolean =>
  error instanceof OwnedSellerClientError && error.code === code

test("the sealed client sends exact OAuth and A2A requests and exposes only untrusted payload and sanitized metrics", async () => {
  const rawSellerBody = Buffer.from(JSON.stringify(sellerMessage()))
  const calls: Array<{ url: string; options: SafeFetchOptions }> = []
  const fetch: OwnedSellerSafeFetch = async (url, options) => {
    assert.ok(options)
    calls.push({ url, options })
    return calls.length === 1
      ? jsonResponse(token, { url: descriptor.tokenUrl })
      : jsonResponse(sellerMessage(), { body: rawSellerBody })
  }
  const client = new OwnedSellerClient(descriptor, credentials, { fetch })
  const result = await client.negotiate(request)

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, descriptor.tokenUrl)
  assert.equal(calls[0]?.options.method, "POST")
  assert.equal(calls[0]?.options.maxRedirects, 0)
  assert.equal(calls[0]?.options.maxBytes, 16_384)
  assert.equal(calls[0]?.options.maxRequestBytes, 16_384)
  assert.equal(calls[0]?.options.headers?.accept, "application/json")
  assert.equal(calls[0]?.options.headers?.["content-type"], "application/x-www-form-urlencoded")
  assert.equal(calls[0]?.options.headers?.authorization, undefined)
  const form = new URLSearchParams(textBody(calls[0]!.options))
  assert.deepEqual(Object.fromEntries(form), {
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: descriptor.oauthScope,
  })

  assert.equal(calls[1]?.url, descriptor.invocationUrl)
  assert.equal(calls[1]?.options.method, "POST")
  assert.equal(calls[1]?.options.maxRedirects, 0)
  assert.equal(calls[1]?.options.maxBytes, 131_072)
  assert.equal(calls[1]?.options.maxRequestBytes, 16_384)
  assert.equal(calls[1]?.options.headers?.authorization, `Bearer ${token.access_token}`)
  assert.equal(calls[1]?.options.headers?.["content-type"], "application/json")
  assert.deepEqual(JSON.parse(textBody(calls[1]!.options)) as unknown, {
    jsonrpc: "2.0",
    id: request.requestId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: request.requestId,
        parts: [{ kind: "data", data: request.data }],
      },
    },
  })

  assert.deepEqual(result.payload, { quote: "untrusted" })
  assert.equal(result.metrics.sellerKey, descriptor.key)
  assert.equal(result.metrics.responseByteLength, rawSellerBody.byteLength)
  assert.equal(
    result.metrics.responseSha256,
    `0x${createHash("sha256").update(rawSellerBody).digest("hex")}`,
  )
  assert.ok(Number.isSafeInteger(result.metrics.oauthLatencyMilliseconds))
  assert.ok(Number.isSafeInteger(result.metrics.invocationLatencyMilliseconds))
  assert.equal(JSON.stringify(client).includes(credentials.clientSecret), false)
  assert.equal(JSON.stringify(result).includes(credentials.clientSecret), false)
  assert.equal(JSON.stringify(result).includes(token.access_token), false)
})

test("configuration pins the token and invocation endpoints to the exact seller origin", () => {
  const invalidDescriptors = [
    { ...descriptor, origin: "https://range.knot.example/" },
    { ...descriptor, origin: "https://range.knot.example/path" },
    { ...descriptor, tokenUrl: "https://auth.knot.example/oauth/token" },
    { ...descriptor, tokenUrl: "https://range.knot.example/oauth/token?audience=seller" },
    { ...descriptor, invocationUrl: "https://range.knot.example/invoke" },
    { ...descriptor, invocationUrl: "https://range.knot.example/#invoke" },
  ]
  for (const invalidDescriptor of invalidDescriptors) {
    assert.throws(
      () => new OwnedSellerClient(invalidDescriptor, credentials),
      errorCode("INVALID_CONFIGURATION"),
    )
  }
  assert.throws(
    () => new OwnedSellerClient(descriptor, { ...credentials, clientSecret: "too-short" }),
    errorCode("INVALID_CONFIGURATION"),
  )
})

test("invalid and oversized invocation data is rejected before credentials are sent", async () => {
  let calls = 0
  const fetch: OwnedSellerSafeFetch = async () => {
    calls += 1
    return jsonResponse(token)
  }
  const client = new OwnedSellerClient(descriptor, credentials, { fetch })
  await assert.rejects(
    client.negotiate({ requestId: "bad id", data: request.data }),
    errorCode("INVALID_REQUEST"),
  )
  await assert.rejects(
    client.negotiate({ requestId: "large-request", data: { value: "x".repeat(17_000) } }),
    errorCode("INVALID_REQUEST"),
  )
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await assert.rejects(
    client.negotiate({ requestId: "cyclic-request", data: cyclic }),
    errorCode("INVALID_REQUEST"),
  )
  assert.equal(calls, 0)
})

test("OAuth responses require exact status, media type, token type, scope, lifetime, and shape", async () => {
  const cases: Array<{ name: string; response: SafeFetchResponse }> = [
    { name: "status", response: jsonResponse(token, { status: 201 }) },
    { name: "media type", response: jsonResponse(token, { headers: { "content-type": "text/plain" } }) },
    { name: "invalid JSON", response: jsonResponse(token, { body: Buffer.from("{") }) },
    { name: "unknown field", response: jsonResponse({ ...token, debug: true }) },
    { name: "token type", response: jsonResponse({ ...token, token_type: "bearer" }) },
    { name: "scope", response: jsonResponse({ ...token, scope: "knot:other:invoke" }) },
    { name: "zero lifetime", response: jsonResponse({ ...token, expires_in: 0 }) },
    { name: "long lifetime", response: jsonResponse({ ...token, expires_in: 901 }) },
    { name: "unsafe token", response: jsonResponse({ ...token, access_token: "secret token" }) },
  ]
  for (const value of cases) {
    let calls = 0
    const fetch: OwnedSellerSafeFetch = async () => {
      calls += 1
      return value.response
    }
    const client = new OwnedSellerClient(descriptor, credentials, { fetch })
    await assert.rejects(client.negotiate(request), errorCode("OAUTH_RESPONSE_INVALID"), value.name)
    assert.equal(calls, 1, value.name)
  }
})

test("A2A responses require status, JSON media type, echoed JSON-RPC ID, strict result shape, and one data part", async () => {
  const cases: Array<{ name: string; response: SafeFetchResponse }> = [
    { name: "status", response: jsonResponse(sellerMessage(), { status: 202 }) },
    { name: "media type", response: jsonResponse(sellerMessage(), { headers: { "content-type": "text/plain" } }) },
    { name: "invalid JSON", response: jsonResponse(sellerMessage(), { body: Buffer.from("{") }) },
    { name: "mismatched id", response: jsonResponse(sellerMessage("another-request")) },
    { name: "JSON-RPC error", response: jsonResponse({ jsonrpc: "2.0", id: request.requestId, error: { code: -1 } }) },
    { name: "unknown field", response: jsonResponse({ ...sellerMessage(), debug: true }) },
    {
      name: "two parts",
      response: jsonResponse({
        ...sellerMessage(),
        result: {
          ...sellerMessage().result,
          parts: [{ kind: "data", data: {} }, { kind: "data", data: {} }],
        },
      }),
    },
    {
      name: "text part",
      response: jsonResponse({
        ...sellerMessage(),
        result: { ...sellerMessage().result, parts: [{ kind: "text", text: "quote" }] },
      }),
    },
  ]
  for (const value of cases) {
    let calls = 0
    const fetch: OwnedSellerSafeFetch = async () => {
      calls += 1
      return calls === 1 ? jsonResponse(token) : value.response
    }
    const client = new OwnedSellerClient(descriptor, credentials, { fetch })
    await assert.rejects(client.negotiate(request), errorCode("SELLER_RESPONSE_INVALID"), value.name)
    assert.equal(calls, 2, value.name)
  }
})

test("transport errors and aborts are sanitized without exposing credentials", async () => {
  const secretFailure = `failure contained ${credentials.clientSecret}`
  const unavailable = new OwnedSellerClient(descriptor, credentials, {
    fetch: async () => {
      throw new Error(secretFailure)
    },
  })
  await assert.rejects(unavailable.negotiate(request), (error) => {
    assert.ok(error instanceof OwnedSellerClientError)
    assert.equal(error.code, "OAUTH_UNAVAILABLE")
    assert.equal(error.retryable, true)
    assert.equal(error.message.includes(credentials.clientSecret), false)
    return true
  })

  const aborted = new OwnedSellerClient(descriptor, credentials, {
    fetch: async () => {
      throw new SafeFetchError("REQUEST_ABORTED", "secret transport details")
    },
  })
  await assert.rejects(aborted.negotiate(request), errorCode("REQUEST_ABORTED"))
})

test("one total deadline covers both OAuth and seller invocation", async () => {
  const times = [0, 0, 0, 450, 450, 450]
  let calls = 0
  const client = new OwnedSellerClient(descriptor, credentials, {
    timeoutMilliseconds: 500,
    nowMilliseconds: () => times.shift() ?? 450,
    fetch: async () => {
      calls += 1
      return jsonResponse(token)
    },
  })
  await assert.rejects(client.negotiate(request), errorCode("SELLER_UNAVAILABLE"))
  assert.equal(calls, 1)
})
