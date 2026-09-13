import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import { POST as confirmFunding } from "../../apps/web/app/api/self-service/verified-quotes/[verifiedQuoteId]/funding-confirmation/route.ts"
import { POST as readStatus } from "../../apps/web/app/api/self-service/verified-quotes/[verifiedQuoteId]/hire-status/route.ts"
import { decodeBuyerIntent } from "../../apps/web/src/server-buyer-intent.ts"

const quoteId = "vq_lifecycle_test"
const origin = "https://knotmarkets.xyz"
const account = privateKeyToAccount(`0x${"55".repeat(32)}`)
const hashes = [1, 2, 3, 4, 5].map(value => `0x${String(value).repeat(64)}`)
const fundingBody = { creationTransactionHash: hashes[0], fundingTransactionHashes: hashes.slice(1) }
const token = "l".repeat(48)
const realFetch = globalThis.fetch
let upstream: { url: string; init: RequestInit | undefined }[] = []

const request = (path: string, body: unknown, idempotencyKey = quoteId) => new Request(`https://knotmarkets.xyz${path}`, {
  method: "POST",
  headers: { origin, "content-type": "application/json", "idempotency-key": idempotencyKey },
  body: JSON.stringify(body),
})
const context = { params: Promise.resolve({ verifiedQuoteId: quoteId }) }

beforeEach(() => {
  process.env.KNOT_API_AUTH_TOKEN = token
  upstream = []
  globalThis.fetch = (async (input, init) => {
    upstream.push({ url: String(input), init })
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; delete process.env.KNOT_API_AUTH_TOKEN })

test("HIRE-PROXY-LIVE-01 funding draft binds the exact ordered hashes to CONFIRM_FUNDING", async () => {
  const response = await confirmFunding(request(`/api/self-service/verified-quotes/${quoteId}/funding-confirmation`, {
    stage: "DRAFT", buyer: account.address, body: fundingBody,
  }), context)
  assert.equal(response.status, 200)
  assert.equal(upstream.length, 0)
  const draft = await response.json() as Record<string, unknown>
  const intent = decodeBuyerIntent(String(draft.intent))
  assert.equal(intent.action, "CONFIRM_FUNDING")
  assert.equal(intent.resourceId, quoteId)
  assert.equal(intent.idempotencyKey, quoteId)
})

test("HIRE-PROXY-LIVE-02 signed status proof forwards an empty body and keeps the server token private", async () => {
  const path = `/api/self-service/verified-quotes/${quoteId}/hire-status`
  const draft = await (await readStatus(request(path, { stage: "DRAFT", buyer: account.address, body: {} }), context)).json() as Record<string, unknown>
  const signature = await account.signMessage({ message: String(draft.message) })
  const response = await readStatus(request(path, { stage: "SIGNED", intent: draft.intent, signature, body: {} }), context)
  assert.equal(response.status, 202)
  assert.equal(upstream.length, 1)
  assert.match(upstream[0]!.url, /\/api\/self-service\/verified-quotes\/vq_lifecycle_test\/hire-status$/)
  assert.equal(upstream[0]!.init?.body, "{}")
  const headers = upstream[0]!.init?.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${token}`)
  assert.equal(headers["x-knot-buyer-signature"], signature)
  assert.doesNotMatch(await response.text(), new RegExp(token))
})

test("HIRE-PROXY-LIVE-03 changed hashes cannot reuse a signed funding intent", async () => {
  const path = `/api/self-service/verified-quotes/${quoteId}/funding-confirmation`
  const draft = await (await confirmFunding(request(path, { stage: "DRAFT", buyer: account.address, body: fundingBody }), context)).json() as Record<string, unknown>
  const signature = await account.signMessage({ message: String(draft.message) })
  const changed = { ...fundingBody, creationTransactionHash: `0x${"9".repeat(64)}` }
  const response = await confirmFunding(request(path, { stage: "SIGNED", intent: draft.intent, signature, body: changed }), context)
  assert.equal(response.status, 401)
  assert.equal(upstream.length, 0)
})

test("HIRE-PROXY-LIVE-04 origin and idempotency failures never reach upstream", async () => {
  const path = `/api/self-service/verified-quotes/${quoteId}/hire-status`
  const wrongKey = await readStatus(request(path, { stage: "DRAFT", buyer: account.address, body: {} }, "different"), context)
  assert.equal(wrongKey.status, 400)
  const noOrigin = new Request(`https://knotmarkets.xyz${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": quoteId }, body: "{}" })
  assert.equal((await readStatus(noOrigin, context)).status, 403)
  assert.equal(upstream.length, 0)
})
