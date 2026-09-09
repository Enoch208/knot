import { readFile } from "node:fs/promises"
import { keccak256 } from "viem"
import { taskSpec } from "../packages/contracts/src/task.ts"
import { serviceRequestEnvelope } from "../packages/contracts/src/service-request.ts"

const identifier = /^[A-Za-z0-9_-]{1,64}$/
const baseUrl = process.env.KNOT_API_BASE_URL ?? "https://knot-api.truematchx.com"
const authToken = process.env.KNOT_API_AUTH_TOKEN
const allowedOrigin = process.env.KNOT_API_ALLOWED_ORIGIN
const runId = process.argv[2]

if (!runId || !identifier.test(runId)) throw new Error("usage: node scripts/run-verified-quote-demo.ts RUN_ID")
if (!authToken || authToken.length < 32) throw new Error("KNOT_API_AUTH_TOKEN is unavailable")
if (!allowedOrigin) throw new Error("KNOT_API_ALLOWED_ORIGIN is unavailable")

const apiOrigin = new URL(baseUrl)
const requestOrigin = new URL(allowedOrigin)
if (apiOrigin.origin !== baseUrl || !["https:", "http:"].includes(apiOrigin.protocol)) throw new Error("KNOT_API_BASE_URL must be an origin")
if (apiOrigin.protocol === "http:" && !["127.0.0.1", "localhost"].includes(apiOrigin.hostname)) throw new Error("KNOT_API_BASE_URL must use HTTPS")
if (requestOrigin.origin !== allowedOrigin || requestOrigin.protocol !== "https:") throw new Error("KNOT_API_ALLOWED_ORIGIN must be an HTTPS origin")

const fixtureTask = JSON.parse(await readFile("evidence/advantage/rangepilot-1189/task.json", "utf8")) as Record<string, unknown>
const fixtureRequest = JSON.parse(await readFile("evidence/advantage/rangepilot-1189/input.json", "utf8")) as {
  task: Record<string, unknown>
}
const taskId = `demo-range-${runId}`
const serviceRequestId = `demo-range-quote-${runId}`
const deadlineUtc = new Date(Date.now() + 30 * 60_000).toISOString()
const request = structuredClone(fixtureRequest)
request.task.taskId = taskId
const requestBytes = Buffer.from(JSON.stringify(request), "utf8")
const inputHash = keccak256(requestBytes)
const task = taskSpec.parse({ ...fixtureTask, taskId, inputHash, deadlineUtc })
const envelope = serviceRequestEnvelope.parse({
  schemaVersion: "knot.service-request/1",
  task,
  request: {
    mediaType: "application/json",
    schemaVersion: "knot.rangepilot.request/1",
    bytesBase64url: requestBytes.toString("base64url"),
  },
  transport: "deflate-base64url",
})

const taskResult = await post(`/api/tasks`, taskId, { task, accessScope: { visibility: "PRIVATE" } })
const serviceRequestResult = await post(`/api/tasks/${taskId}/service-requests`, serviceRequestId, {
  id: serviceRequestId,
  endpoint: "https://knot-range.truematchx.com",
  envelope,
})
const quoteResult = await post(`/api/service-requests/${serviceRequestId}/verified-quotes`, serviceRequestId, {})
const retryResult = await post(`/api/service-requests/${serviceRequestId}/verified-quotes`, serviceRequestId, {})
const quote = verifiedQuote(quoteResult.body)
const retry = verifiedQuote(retryResult.body)
if (quote.id !== serviceRequestId || quote.taskId !== taskId || quote.negotiationHash !== retry.negotiationHash) {
  throw new Error("verified quote response does not preserve immutable identifiers")
}
if (quote.fundingPermitted !== false || retry.fundingPermitted !== false) throw new Error("verified quote unexpectedly permits funding")

process.stdout.write(`${JSON.stringify({
  schemaVersion: "knot.verified-quote-demo/1",
  capturedAtUtc: new Date().toISOString(),
  mode: "QUOTE_ONLY",
  taskId,
  serviceRequestId,
  input: {
    category: task.category,
    capability: task.capability,
    identityChainId: task.identityChainId,
    dataChainId: task.dataChainId,
    paymentChainId: task.paymentChainId,
    executionChainId: task.executionChainId,
    snapshotId: task.snapshotId,
    requestByteLength: requestBytes.length,
    inputHash,
    source: "retained RangePilot 1189 analysis fixture",
  },
  api: {
    origin: apiOrigin.origin,
    taskStatus: taskResult.status,
    serviceRequestStatus: serviceRequestResult.status,
    quoteStatus: quoteResult.status,
    idempotentRetryStatus: retryResult.status,
  },
  verifiedQuote: quote,
  idempotency: {
    sameNegotiationHash: true,
    retryCreatedNoReplacement: retryResult.status === 200,
  },
  boundary: {
    fundingPermitted: false,
    jobCreated: false,
    walletAccessed: false,
    chainWritePerformed: false,
    mainnetWritePerformed: false,
    retainedMainnetSnapshotOnly: true,
  },
}, null, 2)}\n`)

async function post(path: string, idempotencyKey: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiOrigin.origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      origin: requestOrigin.origin,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  })
  const responseBody = await response.json() as unknown
  if (![200, 201].includes(response.status)) throw new Error(`KNOT API request failed with HTTP ${response.status}`)
  return { status: response.status, body: responseBody }
}

function verifiedQuote(value: unknown): {
  id: string
  taskId: string
  negotiationHash: string
  fundingPermitted: false
  [key: string]: unknown
} {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).stage !== "VERIFIED_PRE_FUNDING" ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    typeof (value as Record<string, unknown>).taskId !== "string" ||
    typeof (value as Record<string, unknown>).negotiationHash !== "string" ||
    (value as Record<string, unknown>).fundingPermitted !== false
  ) throw new Error("KNOT API returned an invalid verified quote response")
  return value as ReturnType<typeof verifiedQuote>
}
