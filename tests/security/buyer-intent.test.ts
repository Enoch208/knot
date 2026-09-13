import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import {
  BuyerIntentError,
  buyerIntentBodySha256,
  buyerIntentMessage,
  buyerResourcePrefix,
  decodeBuyerIntent,
  encodeBuyerIntent,
  verifyBuyerIntent,
  type BuyerIntent,
} from "../../packages/security/src/buyer-intent.ts"

const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
const body = JSON.stringify({ task: "bounded" })
const now = new Date("2026-09-13T12:00:00.000Z")
const resourceId = `${buyerResourcePrefix(account.address)}quote_1`

const intent = (overrides: Partial<BuyerIntent> = {}): BuyerIntent => ({
  schemaVersion: "knot.buyer-intent/1",
  buyer: account.address,
  chainId: 97,
  origin: "https://knotmarkets.xyz",
  action: "CREATE_VERIFIED_QUOTE",
  resourceId,
  idempotencyKey: resourceId,
  bodySha256: buyerIntentBodySha256(body),
  issuedAtUtc: "2026-09-13T11:59:30.000Z",
  expiresAtUtc: "2026-09-13T12:03:30.000Z",
  ...overrides,
})

const proof = async (value = intent()) => ({
  intent: value,
  signature: await account.signMessage({ message: buyerIntentMessage(value) }),
})

const binding = (overrides = {}) => ({
  action: "CREATE_VERIFIED_QUOTE" as const,
  resourceId,
  idempotencyKey: resourceId,
  origin: "https://knotmarkets.xyz",
  body,
  now,
  ...overrides,
})

describe("buyer-signed self-service intent", () => {
  it("recovers the buyer only from an exact short-lived BSC testnet proof", async () => {
    assert.equal(await verifyBuyerIntent(await proof(), binding()), account.address)
    const encoded = encodeBuyerIntent(intent())
    assert.deepEqual(decodeBuyerIntent(encoded), intent())
    assert.equal(buyerResourcePrefix(account.address), `ss_${account.address.slice(2).toLowerCase()}_`)
  })

  it("rejects substitution of every authority-bearing request field", async () => {
    for (const changed of [
      binding({ body: `${body} ` }),
      binding({ resourceId: `${resourceId}_other` }),
      binding({ idempotencyKey: `${resourceId}_other` }),
      binding({ origin: "https://attacker.example" }),
      binding({ action: "PREPARE_HIRE" as const }),
    ]) {
      await assert.rejects(verifyBuyerIntent(await proof(), changed), BuyerIntentError)
    }
  })

  it("rejects another signer, expiry, excessive lifetime, future issue time, and noncanonical encoding", async () => {
    const attacker = privateKeyToAccount(`0x${"22".repeat(32)}`)
    const value = intent()
    await assert.rejects(
      verifyBuyerIntent({ intent: value, signature: await attacker.signMessage({ message: buyerIntentMessage(value) }) }, binding()),
      /does not match/,
    )
    for (const invalid of [
      intent({ expiresAtUtc: "2026-09-13T12:00:00.000Z" }),
      intent({ issuedAtUtc: "2026-09-13T11:00:00.000Z", expiresAtUtc: "2026-09-13T12:00:01.000Z" }),
      intent({ issuedAtUtc: "2026-09-13T12:02:00.000Z", expiresAtUtc: "2026-09-13T12:03:00.000Z" }),
    ]) await assert.rejects(verifyBuyerIntent(await proof(invalid), binding()), BuyerIntentError)
    assert.throws(() => decodeBuyerIntent(`${encodeBuyerIntent(value)}=`), BuyerIntentError)
  })

  it("fails closed on a mixed-case buyer with an invalid checksum", async () => {
    const invalid = intent({ buyer: "0x19e7E376E7C213B7E7e7e46cc70A5dD086DAff2A" })
    const signed = await proof()
    await assert.rejects(
      verifyBuyerIntent({ ...signed, intent: invalid }, binding()),
      (error: unknown) => error instanceof BuyerIntentError && error.code === "INVALID_PROOF",
    )
  })
})
