import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { expectedPublicSellers, verifyPublicSeller, type ExpectedPublicSeller, type PublicSellerHttpReader } from "../packages/discovery/src/public-sellers.ts"
import { verifySellerAvailabilityEvidence } from "../packages/reliability/src/seller-availability.ts"
import { safeFetch } from "../packages/security/src/index.ts"

type MeasuredJson = { url: string; httpStatus: number; latencyMs: number; body: unknown; sha256: string; byteLength: number }
type MeasuredJsonReference = Omit<MeasuredJson, "body">
type MeasuredStatus = { url: string; httpStatus: number; latencyMs: number }
type CapturedBody = { sha256: string; byteLength: number; bodyBase64: string }

const cadenceMs = 15_000
const sampleCount = 5
const requestTimeoutMs = 10_000
const startedAtMs = Date.now()
const rounds = []
const capturedBodies = new Map<string, CapturedBody>()

for (let index = 0; index < sampleCount; index += 1) {
  await waitUntil(startedAtMs + index * cadenceMs)
  const observedAtUtc = new Date().toISOString()
  const sellers = await Promise.all(expectedPublicSellers.map((expected) => observeSeller(expected)))
  rounds.push({ sequence: index + 1, observedAtUtc, sellers })
  process.stderr.write(`[availability] completed sample ${index + 1}/${sampleCount}\n`)
}

const observedUntilUtc = new Date().toISOString()
const evidence = verifySellerAvailabilityEvidence({
  schemaVersion: "knot.seller-availability-observation/1",
  observedFromUtc: rounds[0]!.observedAtUtc,
  observedUntilUtc,
  observationDurationMs: Date.parse(observedUntilUtc) - Date.parse(rounds[0]!.observedAtUtc),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  method: {
    command: "npm run availability:observe -- --output evidence/operations/seller-availability-20260909.json",
    sampleCountPerSeller: 5,
    intendedCadenceMs: cadenceMs,
    configuredSafeFetchTimeoutMs: requestTimeoutMs,
    maxRedirects: 0,
    transportBoundary: "safeFetch",
    jsonResponseLimitBytes: 131_072,
    unauthenticatedResponseLimitBytes: 65_536,
  },
  boundary: {
    authenticatedRequests: 0,
    chainRpcRequests: 0,
    stateChangingActions: 0,
    transactionSubmissions: 0,
    fundTransferCommands: 0,
  },
  capturedBodies: [...capturedBodies.values()],
  rounds,
  limitations: [
    "One approximately 60-second observation window from one client location was measured.",
    "Client-observed HTTP responses do not establish uptime, an SLA, or server-side availability.",
    "No regional, failover, load, authenticated workflow, or sustained-duration behavior was measured.",
    "Only public cards, registration proofs, and fail-closed unauthenticated invocation responses were sampled.",
  ],
})

const json = `${JSON.stringify(evidence, null, 2)}\n`
const outputIndex = process.argv.indexOf("--output")
if (outputIndex === -1) {
  process.stdout.write(json)
} else {
  const requested = process.argv[outputIndex + 1]
  if (requested !== "evidence/operations/seller-availability-20260909.json") throw new Error("availability evidence output path is not allowlisted")
  writeFileSync(resolve(requested), json, { encoding: "utf8", flag: "wx" })
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", path: requested, rounds: evidence.rounds.length }, null, 2)}\n`)
}

async function observeSeller(expected: ExpectedPublicSeller) {
  const cardUrl = `${expected.origin}/.well-known/agent-card.json`
  const registrationUrl = `${expected.origin}/.well-known/agent-registration.json`
  const invocationUrl = `${expected.origin}/`
  const [agentCard, domainRegistration, unauthenticatedInvocation] = await Promise.all([
    measureJson(cardUrl),
    measureJson(registrationUrl),
    measureUnauthenticated(invocationUrl),
  ])
  const replay: PublicSellerHttpReader = {
    async getJson(url) {
      const measured = url === cardUrl ? agentCard : url === registrationUrl ? domainRegistration : null
      if (measured === null) throw new Error("unexpected replay URL")
      return { status: measured.httpStatus, body: measured.body }
    },
    async postUnauthenticated(url) {
      if (url !== invocationUrl) throw new Error("unexpected replay URL")
      return unauthenticatedInvocation.httpStatus
    },
  }
  const verification = await verifyPublicSeller(replay, expected)
  return {
    key: expected.key,
    origin: expected.origin,
    agentId: expected.agentId,
    verificationOutcome: verification.outcome,
    verificationErrors: verification.errors,
    requests: {
      agentCard: withoutBody(agentCard),
      domainRegistration: withoutBody(domainRegistration),
      unauthenticatedInvocation,
    },
  }
}

async function measureJson(url: string): Promise<MeasuredJson> {
  const started = performance.now()
  const result = await safeFetch(url, { headers: { accept: "application/json" }, maxBytes: 131_072, maxRedirects: 0, timeoutMs: requestTimeoutMs })
  const bytes = Buffer.from(result.body)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  capturedBodies.set(sha256, { sha256, byteLength: bytes.byteLength, bodyBase64: bytes.toString("base64") })
  let body: unknown
  try { body = JSON.parse(bytes.toString("utf8")) as unknown } catch { throw new Error("public seller response was not JSON") }
  return { url, httpStatus: result.status, latencyMs: elapsed(started), body, sha256, byteLength: bytes.byteLength }
}

async function measureUnauthenticated(url: string): Promise<MeasuredStatus> {
  const started = performance.now()
  const result = await safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "availability-observer", method: "message/send", params: {} }),
    maxBytes: 65_536,
    maxRedirects: 0,
    timeoutMs: requestTimeoutMs,
  })
  return { url, httpStatus: result.status, latencyMs: elapsed(started) }
}

function withoutBody(measured: MeasuredJson): MeasuredJsonReference {
  return { url: measured.url, httpStatus: measured.httpStatus, latencyMs: measured.latencyMs, sha256: measured.sha256, byteLength: measured.byteLength }
}

function elapsed(started: number): number {
  return Math.max(1, Math.ceil(performance.now() - started))
}

async function waitUntil(targetMs: number): Promise<void> {
  const delayMs = Math.max(0, targetMs - Date.now())
  if (delayMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delayMs))
}
