import { createHash } from "node:crypto"
import { getAddress } from "viem"

export type BuyerIntent = {
  schemaVersion: "knot.buyer-intent/1"
  buyer: string
  chainId: 97
  origin: string
  action: "CREATE_VERIFIED_QUOTE" | "PREPARE_HIRE" | "CONFIRM_FUNDING" | "READ_HIRE_STATUS"
  resourceId: string
  idempotencyKey: string
  bodySha256: `0x${string}`
  issuedAtUtc: string
  expiresAtUtc: string
}

const keys = [
  "schemaVersion", "buyer", "chainId", "origin", "action", "resourceId",
  "idempotencyKey", "bodySha256", "issuedAtUtc", "expiresAtUtc",
].sort().join(",")

export const buyerIntentBodySha256 = (body: string): `0x${string}` =>
  `0x${createHash("sha256").update(body, "utf8").digest("hex")}`

export function buyerIntentMessage(intent: BuyerIntent): string {
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

export function encodeBuyerIntent(intent: BuyerIntent): string {
  assertBuyerIntent(intent)
  return Buffer.from(JSON.stringify(intent), "utf8").toString("base64url")
}

export function decodeBuyerIntent(value: string): BuyerIntent {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error("invalid buyer intent")
  const bytes = Buffer.from(value, "base64url")
  if (bytes.toString("base64url") !== value) throw new Error("invalid buyer intent")
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown
  assertBuyerIntent(parsed)
  return parsed
}

function assertBuyerIntent(value: unknown): asserts value is BuyerIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid buyer intent")
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(",") !== keys ||
    record.schemaVersion !== "knot.buyer-intent/1" ||
    typeof record.buyer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(record.buyer) ||
    record.chainId !== 97 ||
    typeof record.origin !== "string" || new URL(record.origin).origin !== record.origin ||
    !["CREATE_VERIFIED_QUOTE", "PREPARE_HIRE", "CONFIRM_FUNDING", "READ_HIRE_STATUS"].includes(String(record.action)) ||
    typeof record.resourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.resourceId) ||
    typeof record.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.idempotencyKey) ||
    typeof record.bodySha256 !== "string" || !/^0x[0-9a-f]{64}$/.test(record.bodySha256) ||
    typeof record.issuedAtUtc !== "string" || !Number.isFinite(Date.parse(record.issuedAtUtc)) ||
    typeof record.expiresAtUtc !== "string" || !Number.isFinite(Date.parse(record.expiresAtUtc))
  ) throw new Error("invalid buyer intent")
}
