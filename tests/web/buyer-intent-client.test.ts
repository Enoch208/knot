import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { hexToString } from "viem"
import { signBuyerIntent } from "../../apps/web/src/buyer-intent-client.ts"
import type { Eip1193Provider } from "../../apps/web/src/wallet.ts"

const buyer = "0x1111111111111111111111111111111111111111"

describe("browser buyer-intent signature", () => {
  it("asks the connected EOA to sign the exact readable message", async () => {
    let request: { method: string; params?: readonly unknown[] } | null = null
    const provider: Eip1193Provider = {
      async request(input) {
        request = input
        return `0x${"11".repeat(65)}`
      },
    }
    const result = await signBuyerIntent(provider, buyer, "KNOT Buyer Intent\nexact")
    assert.equal(result.status, "signed")
    assert.equal(request!.method, "personal_sign")
    assert.equal(hexToString(request!.params![0] as `0x${string}`), "KNOT Buyer Intent\nexact")
    assert.equal(request!.params![1], buyer)
  })

  it("reports rejection and malformed signatures without treating them as signed", async () => {
    const rejected = await signBuyerIntent({ request: async () => { throw { code: 4001 } } }, buyer, "message")
    const malformed = await signBuyerIntent({ request: async () => "0xdead" }, buyer, "message")
    assert.deepEqual(rejected, { status: "rejected" })
    assert.equal(malformed.status, "unavailable")
  })
})
