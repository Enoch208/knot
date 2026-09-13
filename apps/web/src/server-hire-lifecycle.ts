import { NextResponse } from "next/server.js"
import { getAddress } from "viem"
import {
  buyerIntentBodySha256,
  buyerIntentMessage,
  decodeBuyerIntent,
  encodeBuyerIntent,
  type BuyerIntent,
} from "./server-buyer-intent.ts"

const API_ORIGIN = "https://knot-api.truematchx.com"
const MUTATION_ORIGIN = "https://knotmarkets.xyz"
const DEVELOPMENT_ORIGIN = "http://localhost:3000"
const MAX_BODY_BYTES = 16_384
const UPSTREAM_TIMEOUT_MILLISECONDS = 45_000
const signaturePattern = /^0x[0-9a-fA-F]{130}$/
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/
const hashPattern = /^0x[0-9a-fA-F]{64}$/
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const responseHeaders = { "Cache-Control": "no-store, max-age=0" }

type LifecycleAction = "CONFIRM_FUNDING" | "READ_HIRE_STATUS"
type LifecycleEndpoint = "funding-confirmation" | "hire-status"

const allowedBrowserOrigins = (): ReadonlySet<string> =>
  process.env.NODE_ENV === "development"
    ? new Set([MUTATION_ORIGIN, DEVELOPMENT_ORIGIN])
    : new Set([MUTATION_ORIGIN])

export async function handleHireLifecycle(
  request: Request,
  verifiedQuoteId: string,
  action: LifecycleAction,
  endpoint: LifecycleEndpoint,
): Promise<Response> {
  const origin = request.headers.get("origin")
  if (!origin || !allowedBrowserOrigins().has(origin)) return failure(403, "AUTHORITY_MISMATCH", "The request origin is not allowed.", false)
  if (!identifierPattern.test(verifiedQuoteId)) return failure(400, "INVALID_REQUEST", "The verified quote identifier is invalid.", false)
  if (request.headers.get("idempotency-key") !== verifiedQuoteId) return failure(400, "INVALID_REQUEST", "Idempotency-Key must equal the verified quote identifier.", false)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(400, "INVALID_REQUEST", "Content-Type must be application/json.", false)
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return failure(413, "INVALID_REQUEST", "The request body exceeds the allowed size.", false)
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { return failure(400, "INVALID_REQUEST", "The request body is not valid JSON.", false) }
  const record = asRecord(parsed)
  const canonicalBody = readCanonicalBody(record.body, endpoint)
  if (canonicalBody === null) return failure(400, "INVALID_REQUEST", "The lifecycle request body is invalid.", false)
  if (record.stage === "DRAFT") return draft(record, verifiedQuoteId, action, canonicalBody)
  if (record.stage === "SIGNED") return execute(record, verifiedQuoteId, action, endpoint, canonicalBody)
  return failure(400, "INVALID_REQUEST", "Choose the lifecycle authorization stage.", false)
}

function draft(record: Record<string, unknown>, verifiedQuoteId: string, action: LifecycleAction, body: string): Response {
  if (hasUnknownKeys(record, ["stage", "buyer", "body"])) return failure(400, "INVALID_REQUEST", "The lifecycle authorization draft is invalid.", false)
  const buyer = readAddress(record.buyer)
  if (!buyer) return failure(400, "INVALID_REQUEST", "Connect the buyer EOA shown in the reviewed quote.", false)
  const issuedAt = new Date()
  const intent: BuyerIntent = {
    schemaVersion: "knot.buyer-intent/1",
    buyer,
    chainId: 97,
    origin: MUTATION_ORIGIN,
    action,
    resourceId: verifiedQuoteId,
    idempotencyKey: verifiedQuoteId,
    bodySha256: buyerIntentBodySha256(body),
    issuedAtUtc: issuedAt.toISOString(),
    expiresAtUtc: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
  }
  return NextResponse.json({
    stage: "SIGNATURE_REQUIRED",
    accountType: "EOA",
    chainId: 97,
    buyer,
    intent: encodeBuyerIntent(intent),
    message: buyerIntentMessage(intent),
    disclaimer: "This signature authorizes only this exact status operation. It does not authorize a transaction or mainnet write.",
  }, { status: 200, headers: responseHeaders })
}

async function execute(record: Record<string, unknown>, verifiedQuoteId: string, action: LifecycleAction, endpoint: LifecycleEndpoint, body: string): Promise<Response> {
  if (hasUnknownKeys(record, ["stage", "intent", "signature", "body"]) || typeof record.intent !== "string" ||
      typeof record.signature !== "string" || !signaturePattern.test(record.signature)) {
    return failure(400, "INVALID_REQUEST", "The signed lifecycle request is invalid.", false)
  }
  try {
    const intent = decodeBuyerIntent(record.intent)
    if (intent.action !== action || intent.chainId !== 97 || intent.origin !== MUTATION_ORIGIN || intent.resourceId !== verifiedQuoteId ||
        intent.idempotencyKey !== verifiedQuoteId || intent.bodySha256 !== buyerIntentBodySha256(body)) {
      return failure(401, "AUTHORITY_MISMATCH", "The signature does not match this lifecycle request.", false)
    }
  } catch {
    return failure(400, "INVALID_REQUEST", "The signed lifecycle request is invalid.", false)
  }
  const authToken = process.env.KNOT_API_AUTH_TOKEN
  if (!authToken || authToken.length < 32) return failure(503, "UPSTREAM_UNAVAILABLE", "Live hire status is temporarily unavailable.", true)
  try {
    const upstream = await fetch(`${API_ORIGIN}/api/self-service/verified-quotes/${encodeURIComponent(verifiedQuoteId)}/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        "idempotency-key": verifiedQuoteId,
        origin: MUTATION_ORIGIN,
        "x-correlation-id": `web-${endpoint}-${verifiedQuoteId}`,
        "x-knot-buyer-intent": record.intent,
        "x-knot-buyer-signature": record.signature,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MILLISECONDS),
    })
    const result = asRecord(await upstream.json() as unknown)
    if (![200, 202].includes(upstream.status)) {
      if ([401, 403].includes(upstream.status)) return failure(503, "UPSTREAM_UNAVAILABLE", "Live hire status is temporarily unavailable.", true)
      const explanation = typeof result.explanation === "string" ? result.explanation : "The lifecycle service refused the request."
      return failure(upstream.status >= 500 ? 503 : upstream.status, typeof result.code === "string" ? result.code : "UPSTREAM_UNAVAILABLE", explanation, result.retryable === true)
    }
    return NextResponse.json(result, { status: upstream.status, headers: responseHeaders })
  } catch {
    return failure(502, "RESULT_INCOMPLETE", "The lifecycle response is unresolved. No transaction was sent.", true)
  }
}

function readCanonicalBody(value: unknown, endpoint: LifecycleEndpoint): string | null {
  const body = asRecord(value)
  if (endpoint === "hire-status") return Object.keys(body).length === 0 ? "{}" : null
  if (Object.keys(body).sort().join(",") !== "creationTransactionHash,fundingTransactionHashes" || !hashPattern.test(String(body.creationTransactionHash)) ||
      !Array.isArray(body.fundingTransactionHashes) || body.fundingTransactionHashes.length !== 4 ||
      body.fundingTransactionHashes.some(hash => typeof hash !== "string" || !hashPattern.test(hash))) return null
  const hashes = [body.creationTransactionHash as string, ...(body.fundingTransactionHashes as string[])].map(hash => hash.toLowerCase())
  if (new Set(hashes).size !== hashes.length) return null
  return JSON.stringify({ creationTransactionHash: body.creationTransactionHash, fundingTransactionHashes: body.fundingTransactionHashes })
}

function readAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !addressPattern.test(value)) return null
  try { return getAddress(value) } catch { return null }
}

const hasUnknownKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(record).some(key => !allowed.includes(key))
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const failure = (status: number, code: string, explanation: string, retryable: boolean): Response =>
  NextResponse.json({ code, explanation, retryable }, { status, headers: responseHeaders })
