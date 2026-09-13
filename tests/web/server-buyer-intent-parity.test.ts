import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buyerIntentBodySha256 as apiHash,
  buyerIntentMessage as apiMessage,
  decodeBuyerIntent as apiDecode,
  type BuyerIntent,
} from "../../packages/security/src/buyer-intent.ts"
import {
  buyerIntentBodySha256 as proxyHash,
  buyerIntentMessage as proxyMessage,
  encodeBuyerIntent as proxyEncode,
  type BuyerIntent as ProxyBuyerIntent,
} from "../../apps/web/src/server-buyer-intent.ts"

test("the Next proxy and API use an identical buyer-intent wire format", () => {
  const body = JSON.stringify({ exact: true })
  const intent: BuyerIntent & ProxyBuyerIntent = {
    schemaVersion: "knot.buyer-intent/1",
    buyer: "0x1111111111111111111111111111111111111111",
    chainId: 97,
    origin: "https://knotmarkets.xyz",
    action: "CREATE_VERIFIED_QUOTE",
    resourceId: "ss_1111111111111111111111111111111111111111_quote",
    idempotencyKey: "ss_1111111111111111111111111111111111111111_quote",
    bodySha256: apiHash(body),
    issuedAtUtc: "2026-09-13T12:00:00.000Z",
    expiresAtUtc: "2026-09-13T12:04:00.000Z",
  }
  assert.equal(proxyHash(body), apiHash(body))
  assert.equal(proxyMessage(intent), apiMessage(intent))
  assert.deepEqual(apiDecode(proxyEncode(intent)), intent)
})
