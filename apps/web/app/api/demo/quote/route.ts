import { NextResponse } from "next/server.js"
import { keccak256 } from "viem"
import { buildDemoQuoteExample, type DemoAgentSlug } from "../../../../src/demo/quote-examples.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const API_ORIGIN = "https://knot-api.truematchx.com"
const MUTATION_ORIGIN = "https://knotmarkets.xyz"
const responseHeaders = { "Cache-Control": "no-store, max-age=0" }
const allowedWidths = new Set([600, 1200, 2400])
const allowedSlippage = new Set([25, 50, 75])
const allowedAgents = new Set<DemoAgentSlug>(["healthguard", "rangepilot", "gridquant", "yieldscout"])

type UpstreamResponse = { status: number; body: unknown }

export async function POST(request: Request) {
  const authToken = process.env.KNOT_API_AUTH_TOKEN
  if (!authToken || authToken.length < 32) {
    return failure(503, "DEMO_UNAVAILABLE", "The verified quote demo is temporarily unavailable.", true)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return failure(400, "INVALID_REQUEST", "Choose one of the supported example settings.", false)
  }

  const options = readOptions(body)
  if (!options) {
    return failure(400, "INVALID_REQUEST", "Choose one of the supported example settings.", false)
  }

  const example = buildDemoQuoteExample(options)
  const { taskId, serviceRequestId, requestBytes, task } = example
  const inputHash = keccak256(requestBytes)
  const envelope = {
    schemaVersion: "knot.service-request/1",
    task,
    request: {
      mediaType: "application/json",
      schemaVersion: example.requestSchemaVersion,
      bytesBase64url: requestBytes.toString("base64url"),
    },
    transport: example.transport,
  }

  try {
    const taskResult = await postUpstream("/api/tasks", taskId, { task, accessScope: { visibility: "PRIVATE" } }, authToken)
    const serviceRequestResult = await postUpstream(
      `/api/tasks/${taskId}/service-requests`,
      serviceRequestId,
      { id: serviceRequestId, endpoint: example.sellerOrigin, envelope },
      authToken,
    )
    const quoteResult = await postUpstream(
      `/api/service-requests/${serviceRequestId}/verified-quotes`,
      serviceRequestId,
      {},
      authToken,
    )
    const quote = asRecord(quoteResult.body)
    const identity = asRecord(quote.identity)
    const signedQuote = asRecord(quote.quote)
    const quoteResponse = asRecord(signedQuote.response)
    const terms = asRecord(quoteResponse.terms)

    if (
      quote.stage !== "VERIFIED_PRE_FUNDING" ||
      typeof quote.id !== "string" ||
      quote.fundingPermitted !== false ||
      quote.taskId !== taskId ||
      typeof quote.negotiationHash !== "string" ||
      typeof identity.owner !== "string"
    ) {
      throw new Error("upstream quote did not preserve the verified boundary")
    }

    return NextResponse.json(
      {
        stage: "VERIFIED_PRE_FUNDING",
        mode: "QUOTE_ONLY",
        verifiedQuoteId: quote.id,
        agent: {
          name: example.agentName,
          relation: "KNOT-operated",
          endpoint: example.sellerOrigin,
          agentId: quote.providerAgentId,
        },
        task: {
          id: taskId,
          serviceRequestId,
          category: example.categoryLabel,
          capability: "Analysis only",
          bindings: example.bindings,
          snapshotBlock: example.snapshotBlock,
          snapshotObservedAt: example.snapshotObservedAt,
          inputHash,
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
        lifecycle: {
          taskStatus: taskResult.status,
          serviceRequestStatus: serviceRequestResult.status,
          quoteStatus: quoteResult.status,
        },
        boundary: {
          fundingPermitted: false,
          walletAccessed: false,
          jobCreated: false,
          chainWritePerformed: false,
          mainnetWritePerformed: false,
        },
      },
      { status: 200, headers: responseHeaders },
    )
  } catch (error) {
    if (error instanceof UpstreamError) {
      return failure(error.status, error.code, error.explanation, error.retryable)
    }
    return failure(502, "RESULT_INCOMPLETE", "The quote could not be verified. No funds moved.", true)
  }
}

function readOptions(value: unknown): {
  agentSlug: DemoAgentSlug
  targetRangeWidthTicks?: 600 | 1200 | 2400
  maximumSlippageBps?: 25 | 50 | 75
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !["agentSlug", "targetRangeWidthTicks", "maximumSlippageBps"].includes(key))) return null
  const agentSlug = record.agentSlug
  if (typeof agentSlug !== "string" || !allowedAgents.has(agentSlug as DemoAgentSlug)) return null
  if (agentSlug !== "rangepilot") return { agentSlug: agentSlug as DemoAgentSlug }
  if (!allowedWidths.has(Number(record.targetRangeWidthTicks)) || !allowedSlippage.has(Number(record.maximumSlippageBps))) return null
  return {
    agentSlug,
    targetRangeWidthTicks: Number(record.targetRangeWidthTicks) as 600 | 1200 | 2400,
    maximumSlippageBps: Number(record.maximumSlippageBps) as 25 | 50 | 75,
  }
}

async function postUpstream(path: string, idempotencyKey: string, body: unknown, authToken: string): Promise<UpstreamResponse> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: MUTATION_ORIGIN,
      "x-correlation-id": `web-${idempotencyKey}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  })
  const responseBody = await response.json() as unknown
  if (![200, 201].includes(response.status)) {
    const failureBody = asRecord(responseBody)
    throw new UpstreamError(
      response.status >= 500 ? 503 : response.status,
      typeof failureBody.code === "string" ? failureBody.code : "UPSTREAM_UNAVAILABLE",
      typeof failureBody.explanation === "string" ? failureBody.explanation : "The quote service is unavailable.",
      failureBody.retryable === true,
    )
  }
  return { status: response.status, body: responseBody }
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function failure(status: number, code: string, explanation: string, retryable: boolean) {
  return NextResponse.json(
    { code, explanation, retryable, financialState: "unfunded" },
    { status, headers: responseHeaders },
  )
}
