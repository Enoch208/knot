import { NextResponse } from "next/server.js"
import { getAddress, keccak256 } from "viem"
import {
  buyerIntentBodySha256,
  buyerIntentMessage,
  decodeBuyerIntent,
  encodeBuyerIntent,
  type BuyerIntent,
} from "../../../../src/server-buyer-intent.ts"
import { buildDemoQuoteExample, type DemoAgentSlug, type DemoQuoteOptions } from "../../../../src/demo/quote-examples.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const API_ORIGIN = "https://knot-api.truematchx.com"
const MUTATION_ORIGIN = "https://knotmarkets.xyz"
const DEVELOPMENT_ORIGIN = "http://localhost:3000"
const responseHeaders = { "Cache-Control": "no-store, max-age=0" }
const addressPattern = /^0x[0-9a-fA-F]{40}$/
const signaturePattern = /^0x[0-9a-fA-F]{130}$/
const allowedAgents = new Set<DemoAgentSlug>(["healthguard", "rangepilot", "gridquant", "yieldscout"])
const allowedWidths = new Set([600, 1200, 2400])
const allowedSlippage = new Set([25, 50, 75])
const MAX_REQUEST_BYTES = 65_536
const MAX_OUTER_BYTES = 100_000

const allowedBrowserOrigins = (): ReadonlySet<string> =>
  process.env.NODE_ENV === "development"
    ? new Set([MUTATION_ORIGIN, DEVELOPMENT_ORIGIN])
    : new Set([MUTATION_ORIGIN])

export async function POST(request: Request): Promise<Response> {
  const browserOrigin = request.headers.get("origin")
  if (!browserOrigin || !allowedBrowserOrigins().has(browserOrigin)) {
    return failure(403, "AUTHORITY_MISMATCH", "The request origin is not allowed.", false)
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return failure(400, "INVALID_REQUEST", "Content-Type must be application/json.", false)
  }
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTER_BYTES) {
    return failure(413, "INVALID_REQUEST", "The request body exceeds the allowed size.", false)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return failure(400, "INVALID_REQUEST", "The request body is not valid JSON.", false)
  }
  const record = asRecord(parsed)
  if (record.stage === "DRAFT") return draft(record)
  if (record.stage === "EXECUTE") return execute(record)
  return failure(400, "INVALID_REQUEST", "Choose the buyer-binding stage.", false)
}

function draft(record: Record<string, unknown>): Response {
  if (hasUnknownKeys(record, ["stage", "buyer", "agentSlug", "targetRangeWidthTicks", "maximumSlippageBps"])) {
    return failure(400, "INVALID_REQUEST", "The buyer-bound quote draft is invalid.", false)
  }
  const options = readOptions(record)
  const buyer = readAddress(record.buyer)
  if (!options || !buyer) return failure(400, "INVALID_REQUEST", "Choose a supported example and connected EOA account.", false)
  const issuedAt = new Date()
  const example = buildDemoQuoteExample(options, issuedAt, buyer)
  const upstreamBody = buildUpstreamBody(example)
  const intent: BuyerIntent = {
    schemaVersion: "knot.buyer-intent/1",
    buyer,
    chainId: 97,
    origin: MUTATION_ORIGIN,
    action: "CREATE_VERIFIED_QUOTE",
    resourceId: example.serviceRequestId,
    idempotencyKey: example.serviceRequestId,
    bodySha256: buyerIntentBodySha256(upstreamBody),
    issuedAtUtc: issuedAt.toISOString(),
    expiresAtUtc: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
  }
  return NextResponse.json({
    stage: "SIGN_BUYER_INTENT",
    accountType: "EOA",
    chainId: 97,
    buyer,
    buyerIntent: encodeBuyerIntent(intent),
    message: buyerIntentMessage(intent),
    requestBodyBase64url: Buffer.from(upstreamBody, "utf8").toString("base64url"),
    disclaimer: "This release verifies EOA signatures only. The signature authorizes this exact quote request; it does not authorize a transaction.",
  }, { status: 200, headers: responseHeaders })
}

async function execute(record: Record<string, unknown>): Promise<Response> {
  if (hasUnknownKeys(record, ["stage", "agentSlug", "targetRangeWidthTicks", "maximumSlippageBps", "buyerIntent", "buyerSignature", "requestBodyBase64url"])) {
    return failure(400, "INVALID_REQUEST", "The signed buyer-bound quote request is invalid.", false)
  }
  const options = readOptions(record)
  if (
    !options ||
    typeof record.buyerIntent !== "string" ||
    typeof record.buyerSignature !== "string" ||
    !signaturePattern.test(record.buyerSignature) ||
    typeof record.requestBodyBase64url !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(record.requestBodyBase64url)
  ) return failure(400, "INVALID_REQUEST", "The signed buyer-bound quote request is invalid.", false)

  let intent: BuyerIntent
  let upstreamBody: string
  try {
    intent = decodeBuyerIntent(record.buyerIntent)
    const bytes = Buffer.from(record.requestBodyBase64url, "base64url")
    if (bytes.toString("base64url") !== record.requestBodyBase64url || bytes.length > MAX_REQUEST_BYTES) throw new Error("invalid body")
    upstreamBody = bytes.toString("utf8")
  } catch {
    return failure(400, "INVALID_REQUEST", "The signed buyer-bound quote request is invalid.", false)
  }
  if (intent.action !== "CREATE_VERIFIED_QUOTE" || intent.chainId !== 97) {
    return failure(400, "INVALID_REQUEST", "The signed intent is not a BSC testnet quote request.", false)
  }
  let expected
  try {
    expected = buildDemoQuoteExample(options, new Date(intent.issuedAtUtc), intent.buyer)
  } catch {
    return failure(400, "INVALID_REQUEST", "The buyer-bound quote request cannot be reproduced.", false)
  }
  if (buildUpstreamBody(expected) !== upstreamBody || intent.resourceId !== expected.serviceRequestId) {
    return failure(401, "AUTHORITY_MISMATCH", "The signed quote request does not match the selected example.", false)
  }
  const authToken = process.env.KNOT_API_AUTH_TOKEN
  if (!authToken || authToken.length < 32) {
    return failure(503, "UPSTREAM_UNAVAILABLE", "The verified quote service is temporarily unavailable.", true)
  }
  try {
    const upstream = await fetch(`${API_ORIGIN}/api/self-service/verified-quotes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        "idempotency-key": expected.serviceRequestId,
        origin: MUTATION_ORIGIN,
        "x-correlation-id": `web-self-service-${expected.serviceRequestId}`,
        "x-knot-buyer-intent": record.buyerIntent,
        "x-knot-buyer-signature": record.buyerSignature,
      },
      body: upstreamBody,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    })
    const responseBody = asRecord(await upstream.json() as unknown)
    if (![200, 201].includes(upstream.status)) throw refusal(upstream.status, responseBody)
    return quoteResponse(responseBody, expected, intent.buyer)
  } catch (error) {
    if (error instanceof UpstreamError) return failure(error.status, error.code, error.explanation, error.retryable)
    return failure(502, "RESULT_INCOMPLETE", "The quote could not be verified. No funds moved.", true)
  }
}

function buildUpstreamBody(example: ReturnType<typeof buildDemoQuoteExample>): string {
  return JSON.stringify({
    task: example.task,
    accessScope: { visibility: "PRIVATE" },
    serviceRequest: {
      id: example.serviceRequestId,
      endpoint: example.sellerOrigin,
      envelope: {
        schemaVersion: "knot.service-request/1",
        task: example.task,
        request: {
          mediaType: "application/json",
          schemaVersion: example.requestSchemaVersion,
          bytesBase64url: example.requestBytes.toString("base64url"),
        },
        transport: example.transport,
      },
    },
  })
}

function quoteResponse(
  quote: Record<string, unknown>,
  example: ReturnType<typeof buildDemoQuoteExample>,
  buyer: string,
): Response {
  const identity = asRecord(quote.identity)
  const signedQuote = asRecord(quote.quote)
  const quoteResult = asRecord(signedQuote.response)
  const terms = asRecord(quoteResult.terms)
  if (
    quote.stage !== "VERIFIED_PRE_FUNDING" ||
    typeof quote.id !== "string" ||
    quote.fundingPermitted !== false ||
    quote.taskId !== example.taskId ||
    typeof quote.negotiationHash !== "string" ||
    typeof identity.owner !== "string" ||
    typeof quote.buyer !== "string" ||
    quote.buyer.toLowerCase() !== buyer.toLowerCase()
  ) throw new Error("upstream quote did not preserve the buyer-bound verified boundary")
  return NextResponse.json({
    stage: "VERIFIED_PRE_FUNDING",
    mode: "QUOTE_ONLY",
    verifiedQuoteId: quote.id,
    buyerBinding: { buyer: quote.buyer, accountType: "EOA", method: "EIP-191", chainId: 97 },
    agent: { name: example.agentName, relation: "KNOT-operated", endpoint: example.sellerOrigin, agentId: quote.providerAgentId },
    task: {
      id: example.taskId,
      serviceRequestId: example.serviceRequestId,
      category: example.categoryLabel,
      capability: "Analysis only",
      bindings: example.bindings,
      snapshotBlock: example.snapshotBlock,
      snapshotObservedAt: example.snapshotObservedAt,
      inputHash: keccak256(example.requestBytes),
    },
    identity: {
      chainId: identity.chainId,
      registry: identity.registry,
      agentId: identity.agentId,
      owner: identity.owner,
      blockNumber: identity.blockNumber,
      blockHash: identity.blockHash,
      observedAt: identity.observedAt,
      confirmation: "Observed through two pinned BSC testnet RPC providers",
    },
    quote: {
      priceUnits: terms.price,
      token: terms.currency,
      decimals: 18,
      deliverables: terms.deliverables,
      qualityStandards: terms.quality_standards,
      expiresAtUnix: quote.expiresAtUnix,
      expired: quote.expired,
      verifiedAt: quote.verifiedAt,
      negotiationHash: quote.negotiationHash,
      requestHash: quote.requestHash,
      responseHash: quote.responseHash,
      signatureMethod: "EIP-191 signer recovery",
    },
    lifecycle: quote.lifecycle,
    boundary: {
      fundingPermitted: false,
      walletAccessed: true,
      jobCreated: false,
      chainWritePerformed: false,
      mainnetWritePerformed: false,
    },
  }, { status: 200, headers: responseHeaders })
}

function readOptions(record: Record<string, unknown>): DemoQuoteOptions | null {
  const slug = record.agentSlug
  if (typeof slug !== "string" || !allowedAgents.has(slug as DemoAgentSlug)) return null
  if (slug !== "rangepilot") return { agentSlug: slug as DemoAgentSlug }
  const width = Number(record.targetRangeWidthTicks)
  const slippage = Number(record.maximumSlippageBps)
  if (!allowedWidths.has(width) || !allowedSlippage.has(slippage)) return null
  return { agentSlug: slug, targetRangeWidthTicks: width as 600 | 1200 | 2400, maximumSlippageBps: slippage as 25 | 50 | 75 }
}

function readAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !addressPattern.test(value)) return null
  try { return getAddress(value) } catch { return null }
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowed.includes(key))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function refusal(status: number, body: Record<string, unknown>): UpstreamError {
  const code = typeof body.code === "string" ? body.code : "UPSTREAM_UNAVAILABLE"
  const explanation = typeof body.explanation === "string" ? body.explanation : "The quote service refused the request."
  return new UpstreamError(status >= 500 ? 503 : status, code, explanation, body.retryable === true)
}

class UpstreamError extends Error {
  readonly status: number
  readonly code: string
  readonly explanation: string
  readonly retryable: boolean
  constructor(
    status: number,
    code: string,
    explanation: string,
    retryable: boolean,
  ) {
    super(explanation)
    this.status = status
    this.code = code
    this.explanation = explanation
    this.retryable = retryable
  }
}

function failure(status: number, code: string, explanation: string, retryable: boolean): Response {
  return NextResponse.json({ code, explanation, retryable, financialState: "unfunded" }, { status, headers: responseHeaders })
}
