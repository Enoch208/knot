export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const API_ORIGIN = "https://knot-api.truematchx.com"
const MUTATION_ORIGIN = "https://knotmarkets.xyz"
const DEVELOPMENT_ORIGIN = "http://localhost:3000"
const MAX_BODY_BYTES = 1024
const UPSTREAM_TIMEOUT_MILLISECONDS = 45_000
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/
const responseHeaders = { "Cache-Control": "no-store, max-age=0" }

const allowedBrowserOrigins = (): ReadonlySet<string> =>
  process.env.NODE_ENV === "development"
    ? new Set([MUTATION_ORIGIN, DEVELOPMENT_ORIGIN])
    : new Set([MUTATION_ORIGIN])

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin")
  if (!origin || !allowedBrowserOrigins().has(origin)) {
    return failure(403, "AUTHORITY_MISMATCH", "The request origin is not allowed to prepare a hire.", false)
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return failure(400, "INVALID_REQUEST", "Content-Type must be application/json.", false)
  }

  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return failure(413, "INVALID_REQUEST", "The request body exceeds the allowed size.", false)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return failure(400, "INVALID_REQUEST", "The request body is not valid JSON.", false)
  }

  const verifiedQuoteId = readVerifiedQuoteId(parsed)
  if (!verifiedQuoteId) {
    return failure(400, "INVALID_REQUEST", "A single verifiedQuoteId identifier is required.", false)
  }
  if (request.headers.get("idempotency-key") !== verifiedQuoteId) {
    return failure(400, "INVALID_REQUEST", "Idempotency-Key must equal the verified quote identifier.", false)
  }

  const authToken = process.env.KNOT_API_AUTH_TOKEN
  if (!authToken || authToken.length < 32) {
    return failure(503, "UPSTREAM_UNAVAILABLE", "Hire preparation is temporarily unavailable.", true)
  }

  try {
    return await forwardPreparation(verifiedQuoteId, authToken)
  } catch (error) {
    if (error instanceof UpstreamError) {
      return failure(error.status, error.code, error.explanation, error.retryable)
    }
    return failure(
      502,
      "RESULT_INCOMPLETE",
      "The hire could not be prepared. Nothing was signed and no funds moved.",
      true,
    )
  }
}

async function forwardPreparation(verifiedQuoteId: string, authToken: string): Promise<Response> {
  const upstream = await fetch(
    `${API_ORIGIN}/api/verified-quotes/${encodeURIComponent(verifiedQuoteId)}/hire-preparation`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        "idempotency-key": verifiedQuoteId,
        origin: MUTATION_ORIGIN,
        "x-correlation-id": `web-hire-${verifiedQuoteId}`,
      },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MILLISECONDS),
    },
  )

  const body = asRecord(await upstream.json() as unknown)
  if (upstream.status !== 200) throw refusal(upstream.status, body)

  const envelope = asRecord(body.envelope)
  const calls = Array.isArray(body.calls) ? body.calls : null
  if (
    !calls ||
    envelope.chainId !== 97 ||
    typeof envelope.budgetBaseUnits !== "string" ||
    typeof envelope.jobId !== "string" ||
    envelope.callCount !== calls.length ||
    body.verifiedQuoteId !== verifiedQuoteId
  ) {
    throw new UpstreamError(
      502,
      "RESULT_INCOMPLETE",
      "The prepared hire did not preserve its reviewable boundary.",
      false,
    )
  }

  return Response.json(
    {
      envelope,
      calls,
      verifiedQuoteId,
      observedAtUtc: body.observedAtUtc,
      blockNumber: body.blockNumber,
    },
    { status: 200, headers: responseHeaders },
  )
}

function refusal(status: number, body: Record<string, unknown>): UpstreamError {
  if (status === 401 || status === 403) {
    return new UpstreamError(503, "UPSTREAM_UNAVAILABLE", "Hire preparation is temporarily unavailable.", true)
  }
  const code = typeof body.code === "string" ? body.code : "UPSTREAM_UNAVAILABLE"
  const explanation =
    typeof body.explanation === "string" ? body.explanation : "The hire preparation service refused the request."
  return new UpstreamError(status >= 500 ? 503 : status, code, explanation, body.retryable === true)
}

function readVerifiedQuoteId(value: unknown): string | null {
  const record = asRecord(value)
  if (Object.keys(record).length !== 1) return null
  const candidate = record.verifiedQuoteId
  return typeof candidate === "string" && identifierPattern.test(candidate) ? candidate : null
}

class UpstreamError extends Error {
  readonly status: number
  readonly code: string
  readonly explanation: string
  readonly retryable: boolean

  constructor(status: number, code: string, explanation: string, retryable: boolean) {
    super(explanation)
    this.name = "UpstreamError"
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

function failure(status: number, code: string, explanation: string, retryable: boolean): Response {
  return Response.json(
    { code, explanation, retryable, financialState: "unfunded" },
    { status, headers: responseHeaders },
  )
}
