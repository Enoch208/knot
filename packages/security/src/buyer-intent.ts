import { createHash } from "node:crypto"
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem"
import { z } from "zod"

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const digest = z.string().regex(/^0x[0-9a-f]{64}$/)
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const buyerIntentAction = z.enum([
  "CREATE_VERIFIED_QUOTE",
  "PREPARE_HIRE",
  "CONFIRM_FUNDING",
  "READ_HIRE_STATUS",
])

export const buyerIntent = z.object({
  schemaVersion: z.literal("knot.buyer-intent/1"),
  buyer: address,
  chainId: z.literal(97),
  origin: z.url(),
  action: buyerIntentAction,
  resourceId: identifier,
  idempotencyKey: identifier,
  bodySha256: digest,
  issuedAtUtc: z.iso.datetime(),
  expiresAtUtc: z.iso.datetime(),
}).strict()

export type BuyerIntent = z.infer<typeof buyerIntent>
export type BuyerIntentAction = z.infer<typeof buyerIntentAction>

export interface BuyerIntentProof {
  intent: BuyerIntent
  signature: Hex
}

export interface BuyerIntentBinding {
  action: BuyerIntentAction
  resourceId: string
  idempotencyKey: string
  origin: string
  body: string
  now: Date
}

export class BuyerIntentError extends Error {
  readonly code:
    | "INVALID_PROOF"
    | "BINDING_MISMATCH"
    | "WRONG_CHAIN"
    | "EXPIRED"
    | "INVALID_WINDOW"
    | "SIGNER_MISMATCH"

  constructor(code: BuyerIntentError["code"], message: string) {
    super(message)
    this.name = "BuyerIntentError"
    this.code = code
  }
}

export const buyerIntentBodySha256 = (body: string): `0x${string}` =>
  `0x${createHash("sha256").update(body, "utf8").digest("hex")}`

export function buyerResourcePrefix(buyer: string): string {
  return `ss_${getAddress(buyer).slice(2).toLowerCase()}_`
}

export function encodeBuyerIntent(intent: BuyerIntent): string {
  const parsed = buyerIntent.parse(intent)
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")
}

export function decodeBuyerIntent(value: string): BuyerIntent {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) {
    throw new BuyerIntentError("INVALID_PROOF", "buyer intent encoding is invalid")
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(value, "base64url")
  } catch {
    throw new BuyerIntentError("INVALID_PROOF", "buyer intent encoding is invalid")
  }
  if (bytes.toString("base64url") !== value) {
    throw new BuyerIntentError("INVALID_PROOF", "buyer intent encoding is not canonical")
  }
  try {
    return buyerIntent.parse(JSON.parse(bytes.toString("utf8")) as unknown)
  } catch {
    throw new BuyerIntentError("INVALID_PROOF", "buyer intent payload is invalid")
  }
}

export function buyerIntentMessage(input: BuyerIntent): string {
  const intent = buyerIntent.parse(input)
  return [
    "KNOT Buyer Intent",
    "",
    `Origin: ${intent.origin}`,
    `Chain ID: ${intent.chainId}`,
    `Buyer: ${getAddress(intent.buyer)}`,
    `Action: ${intent.action}`,
    `Resource ID: ${intent.resourceId}`,
    `Idempotency Key: ${intent.idempotencyKey}`,
    `Body SHA-256: ${intent.bodySha256}`,
    `Issued At: ${intent.issuedAtUtc}`,
    `Expires At: ${intent.expiresAtUtc}`,
    "",
    "This signature authorizes only the exact idempotent testnet action above. It does not authorize a transaction or mainnet write.",
  ].join("\n")
}

export async function verifyBuyerIntent(
  proof: BuyerIntentProof,
  binding: BuyerIntentBinding,
): Promise<Address> {
  const intent = buyerIntent.safeParse(proof.intent)
  if (!intent.success || !signature.safeParse(proof.signature).success) {
    throw new BuyerIntentError("INVALID_PROOF", "buyer intent proof is invalid")
  }
  const value = intent.data
  let signedOrigin: URL
  let expectedOrigin: URL
  try {
    signedOrigin = new URL(value.origin)
    expectedOrigin = new URL(binding.origin)
  } catch {
    throw new BuyerIntentError("BINDING_MISMATCH", "buyer intent origin is invalid")
  }
  if (signedOrigin.origin !== value.origin || expectedOrigin.origin !== binding.origin || value.origin !== binding.origin) {
    throw new BuyerIntentError("BINDING_MISMATCH", "buyer intent origin does not match")
  }
  if (value.chainId !== 97) {
    throw new BuyerIntentError("WRONG_CHAIN", "buyer intent must target BSC testnet")
  }
  if (
    value.action !== binding.action ||
    value.resourceId !== binding.resourceId ||
    value.idempotencyKey !== binding.idempotencyKey ||
    value.bodySha256 !== buyerIntentBodySha256(binding.body)
  ) {
    throw new BuyerIntentError("BINDING_MISMATCH", "buyer intent does not match the requested action")
  }

  const issuedAt = Date.parse(value.issuedAtUtc)
  const expiresAt = Date.parse(value.expiresAtUtc)
  const now = binding.now.getTime()
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 300_000) {
    throw new BuyerIntentError("INVALID_WINDOW", "buyer intent lifetime is invalid")
  }
  if (issuedAt > now + 60_000 || issuedAt < now - 300_000 || expiresAt <= now) {
    throw new BuyerIntentError("EXPIRED", "buyer intent is expired or not yet valid")
  }

  let buyer: Address
  try {
    if (!isAddress(value.buyer, { strict: true })) throw new Error("invalid checksum")
    buyer = getAddress(value.buyer)
  } catch {
    throw new BuyerIntentError("INVALID_PROOF", "buyer address is invalid")
  }
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message: buyerIntentMessage(value), signature: proof.signature })
  } catch {
    throw new BuyerIntentError("INVALID_PROOF", "buyer signature could not be recovered")
  }
  if (recovered.toLowerCase() !== buyer.toLowerCase()) {
    throw new BuyerIntentError("SIGNER_MISMATCH", "buyer signature does not match the claimed address")
  }
  return buyer
}
