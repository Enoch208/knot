import { createHash } from "node:crypto"
import { z } from "zod"
import { expectedPublicSellers } from "../../discovery/src/public-sellers.ts"

const utc = z.iso.datetime()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const httpsUrl = z.url().refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
}, "URL must use HTTPS without embedded credentials")
const response = z.object({ url: httpsUrl, httpStatus: z.number().int().min(100).max(599), latencyMs: z.number().int().positive().max(60_000) }).strict()
const jsonResponse = response.extend({ sha256: digest, byteLength: z.number().int().positive().max(131_072) }).strict()
const capturedBody = z.object({ sha256: digest, byteLength: z.number().int().positive().max(131_072), bodyBase64: z.string().min(4).max(174_764).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()
const seller = z.object({
  key: z.enum(["healthguard", "rangepilot", "gridquant", "yieldscout"]),
  origin: httpsUrl,
  agentId: z.number().int().positive(),
  verificationOutcome: z.literal("VERIFIED"),
  verificationErrors: z.array(z.never()).length(0),
  requests: z.object({
    agentCard: jsonResponse.extend({ httpStatus: z.literal(200) }).strict(),
    domainRegistration: jsonResponse.extend({ httpStatus: z.literal(200) }).strict(),
    unauthenticatedInvocation: response.extend({ httpStatus: z.literal(401) }).strict(),
  }).strict(),
}).strict()
const round = z.object({ sequence: z.number().int().min(1).max(5), observedAtUtc: utc, sellers: z.array(seller).length(4) }).strict()
const card = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  protocolVersion: z.literal("0.3.0"),
  preferredTransport: z.literal("JSONRPC"),
  skills: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  securitySchemes: z.object({ oauth2: z.object({ flows: z.object({ clientCredentials: z.object({ tokenUrl: z.string().url(), scopes: z.record(z.string(), z.string()) }).passthrough() }).passthrough() }).passthrough() }).passthrough(),
  security: z.array(z.record(z.string(), z.array(z.string()))),
}).passthrough()
const registrationProof = z.object({ registrations: z.array(z.object({ agentId: z.number().int().nonnegative(), agentRegistry: z.string().min(1) }).strict()).min(1) }).strict()
const limitations = [
  "One approximately 60-second observation window from one client location was measured.",
  "Client-observed HTTP responses do not establish uptime, an SLA, or server-side availability.",
  "No regional, failover, load, authenticated workflow, or sustained-duration behavior was measured.",
  "Only public cards, registration proofs, and fail-closed unauthenticated invocation responses were sampled.",
] as const
const limitationsSchema = z.tuple([z.literal(limitations[0]), z.literal(limitations[1]), z.literal(limitations[2]), z.literal(limitations[3])])

export const sellerAvailabilityEvidenceSchema = z.object({
  schemaVersion: z.literal("knot.seller-availability-observation/1"),
  observedFromUtc: utc,
  observedUntilUtc: utc,
  observationDurationMs: z.number().int().positive(),
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  method: z.object({
    command: z.literal("npm run availability:observe -- --output evidence/operations/seller-availability-20260909.json"),
    sampleCountPerSeller: z.literal(5),
    intendedCadenceMs: z.literal(15_000),
    configuredSafeFetchTimeoutMs: z.literal(10_000),
    maxRedirects: z.literal(0),
    transportBoundary: z.literal("safeFetch"),
    jsonResponseLimitBytes: z.literal(131_072),
    unauthenticatedResponseLimitBytes: z.literal(65_536),
  }).strict(),
  boundary: z.object({ authenticatedRequests: z.literal(0), chainRpcRequests: z.literal(0), stateChangingActions: z.literal(0), transactionSubmissions: z.literal(0), fundTransferCommands: z.literal(0) }).strict(),
  capturedBodies: z.array(capturedBody).min(1).max(40),
  rounds: z.array(round).length(5),
  limitations: limitationsSchema,
}).strict()

export type SellerAvailabilityEvidence = z.infer<typeof sellerAvailabilityEvidenceSchema>

export interface SellerAvailabilitySummary {
  observationDurationMs: number
  expectedResponseCount: number
  matchedResponseCount: number
  minimumObservedRequestLatencyMs: number
  maximumObservedRequestLatencyMs: number
}

export function verifySellerAvailabilityEvidence(input: unknown): SellerAvailabilityEvidence {
  const evidence = sellerAvailabilityEvidenceSchema.parse(input)
  const startedAt = Date.parse(evidence.observedFromUtc)
  const endedAt = Date.parse(evidence.observedUntilUtc)
  if (endedAt - startedAt !== evidence.observationDurationMs) throw new Error("availability duration does not match timestamps")
  if (evidence.observationDurationMs < 60_000 || evidence.observationDurationMs > 75_000) throw new Error("availability duration is outside the bounded observation window")
  const bodies = verifyCapturedBodies(evidence)
  const references = new Set<string>()
  const expectedKeys = expectedPublicSellers.map((item) => item.key)
  for (const [roundIndex, currentRound] of evidence.rounds.entries()) {
    if (currentRound.sequence !== roundIndex + 1) throw new Error("availability round sequence is not contiguous")
    if (roundIndex === 0 && currentRound.observedAtUtc !== evidence.observedFromUtc) throw new Error("availability start timestamp does not match the first round")
    if (new Set(currentRound.sellers.map((item) => item.key)).size !== expectedPublicSellers.length) throw new Error("availability round contains duplicate sellers")
    if (currentRound.sellers.map((item) => item.key).join(",") !== expectedKeys.join(",")) throw new Error("availability round seller order is incomplete")
    for (const observed of currentRound.sellers) verifySeller(observed, bodies, references)
    const roundMaximumLatencyMs = Math.max(...currentRound.sellers.flatMap((observed) => Object.values(observed.requests).map((request) => request.latencyMs)))
    if (roundMaximumLatencyMs > evidence.method.configuredSafeFetchTimeoutMs) throw new Error("availability request latency exceeds the configured timeout")
    const roundBoundaryMs = roundIndex + 1 < evidence.rounds.length
      ? Date.parse(evidence.rounds[roundIndex + 1]!.observedAtUtc)
      : endedAt
    if (Date.parse(currentRound.observedAtUtc) + roundMaximumLatencyMs > roundBoundaryMs + 250) throw new Error("availability round latency exceeds its observation boundary")
    if (roundIndex > 0) {
      const interval = Date.parse(currentRound.observedAtUtc) - Date.parse(evidence.rounds[roundIndex - 1]!.observedAtUtc)
      if (interval < 13_000 || interval > 17_000) throw new Error("availability cadence is outside the declared tolerance")
    }
  }
  if (references.size !== bodies.size) throw new Error("availability evidence contains an unreferenced captured body")
  const sampleSpan = Date.parse(evidence.rounds[4]!.observedAtUtc) - Date.parse(evidence.rounds[0]!.observedAtUtc)
  if (sampleSpan < 58_000 || sampleSpan > 62_000) throw new Error("availability sample span is not approximately 60 seconds")
  if (endedAt < Date.parse(evidence.rounds[4]!.observedAtUtc)) throw new Error("availability end timestamp precedes the last round")
  return evidence
}

export function deriveSellerAvailabilitySummary(evidence: SellerAvailabilityEvidence): SellerAvailabilitySummary {
  const requests = evidence.rounds.flatMap((item) => item.sellers.flatMap((observed) => Object.values(observed.requests)))
  const latencies = requests.map((request) => request.latencyMs)
  return {
    observationDurationMs: evidence.observationDurationMs,
    expectedResponseCount: evidence.rounds.length * expectedPublicSellers.length * 3,
    matchedResponseCount: requests.length,
    minimumObservedRequestLatencyMs: Math.min(...latencies),
    maximumObservedRequestLatencyMs: Math.max(...latencies),
  }
}

export function availabilityClaimText(summary: SellerAvailabilitySummary): string {
  return `Across one ${(summary.observationDurationMs / 1_000).toFixed(3)}-second client-side window, five samples for each of the four KNOT sellers returned all ${summary.matchedResponseCount} expected public responses: agent cards and domain-registration proofs returned HTTP 200, while unauthenticated invocations returned HTTP 401.`
}

export function availabilityReadmeMetrics(summary: SellerAvailabilitySummary): string {
  return `During a separate [${(summary.observationDurationMs / 1_000).toFixed(3)}-second client-side observation](evidence/operations/seller-availability-20260909.json), five samples per seller at approximately 15-second cadence produced all ${summary.matchedResponseCount} expected responses: every agent card and domain proof returned HTTP 200, and every unauthenticated invocation returned HTTP 401. Individual request latencies ranged from \`${formatInteger(summary.minimumObservedRequestLatencyMs)} ms\` to \`${formatInteger(summary.maximumObservedRequestLatencyMs)} ms\`.`
}

export function verifySellerAvailabilityPublicationBindings(evidenceInput: unknown, claimInput: unknown, readme: string): SellerAvailabilitySummary {
  const evidence = verifySellerAvailabilityEvidence(evidenceInput)
  const summary = deriveSellerAvailabilitySummary(evidence)
  const claim = z.object({
    id: z.literal("seller-short-availability-observation"),
    claim: z.string(),
    scope: z.object({
      sellerCount: z.literal(4), samplesPerSeller: z.literal(5), intendedCadenceMs: z.literal(15_000),
      observationDurationMs: z.number().int(), expectedResponseCount: z.number().int(), matchedResponseCount: z.number().int(),
      minimumObservedRequestLatencyMs: z.number().int(), maximumObservedRequestLatencyMs: z.number().int(),
      agentCardHttpStatus: z.literal(200), domainRegistrationHttpStatus: z.literal(200), unauthenticatedInvocationHttpStatus: z.literal(401),
      transportBoundary: z.literal("safeFetch"), authenticatedRequests: z.literal(0), chainRpcRequests: z.literal(0), stateChangingActions: z.literal(0), transactionSubmissions: z.literal(0), fundTransferCommands: z.literal(0),
    }).strict(),
    observationWindow: z.object({ fromUtc: utc, toUtc: utc }).strict(),
    limitations: limitationsSchema,
  }).passthrough().parse(claimInput)
  if (claim.claim !== availabilityClaimText(summary)) throw new Error("availability claim text does not match captured evidence")
  if (claim.observationWindow.fromUtc !== evidence.observedFromUtc || claim.observationWindow.toUtc !== evidence.observedUntilUtc) throw new Error("availability claim window does not match captured evidence")
  for (const key of Object.keys(summary) as Array<keyof SellerAvailabilitySummary>) {
    if (claim.scope[key] !== summary[key]) throw new Error(`availability claim scope ${key} does not match captured evidence`)
  }
  if (!readme.includes(availabilityReadmeMetrics(summary))) throw new Error("availability README metrics do not match captured evidence")
  return summary
}

function verifyCapturedBodies(evidence: SellerAvailabilityEvidence): Map<string, Uint8Array> {
  const bodies = new Map<string, Uint8Array>()
  for (const captured of evidence.capturedBodies) {
    const bytes = Buffer.from(captured.bodyBase64, "base64")
    if (bytes.toString("base64") !== captured.bodyBase64) throw new Error("availability body encoding is not canonical base64")
    if (bytes.byteLength !== captured.byteLength) throw new Error("availability body length mismatch")
    if (createHash("sha256").update(bytes).digest("hex") !== captured.sha256) throw new Error("availability body hash mismatch")
    if (bodies.has(captured.sha256)) throw new Error("availability evidence contains duplicate captured bodies")
    bodies.set(captured.sha256, bytes)
  }
  return bodies
}

function verifySeller(observed: z.infer<typeof seller>, bodies: Map<string, Uint8Array>, references: Set<string>): void {
  const expected = expectedPublicSellers.find((item) => item.key === observed.key)
  if (expected === undefined || observed.origin !== expected.origin || observed.agentId !== expected.agentId) throw new Error(`unexpected seller identity for ${observed.key}`)
  if (observed.requests.agentCard.url !== `${expected.origin}/.well-known/agent-card.json`) throw new Error(`${observed.key} card URL mismatch`)
  if (observed.requests.domainRegistration.url !== `${expected.origin}/.well-known/agent-registration.json`) throw new Error(`${observed.key} registration URL mismatch`)
  if (observed.requests.unauthenticatedInvocation.url !== `${expected.origin}/`) throw new Error(`${observed.key} invocation URL mismatch`)
  verifyCardBody(readBody(observed.requests.agentCard, bodies, references), expected)
  verifyRegistrationBody(readBody(observed.requests.domainRegistration, bodies, references), expected.agentId)
}

function readBody(request: z.infer<typeof jsonResponse>, bodies: Map<string, Uint8Array>, references: Set<string>): unknown {
  const bytes = bodies.get(request.sha256)
  if (bytes === undefined || bytes.byteLength !== request.byteLength) throw new Error("availability request does not bind a captured response body")
  references.add(request.sha256)
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown } catch { throw new Error("availability response body is not JSON") }
}

function verifyCardBody(input: unknown, expected: (typeof expectedPublicSellers)[number]): void {
  const parsed = card.parse(input)
  if (parsed.name !== expected.cardName || parsed.url !== `${expected.origin}/`) throw new Error(`${expected.key} captured card identity mismatch`)
  const skillIds = new Set(parsed.skills.map((skill) => skill.id))
  if (!skillIds.has("negotiate") || !skillIds.has("notify_funded")) throw new Error(`${expected.key} captured card capability mismatch`)
  const oauth = parsed.securitySchemes.oauth2.flows.clientCredentials
  if (oauth.tokenUrl !== `${expected.origin}/oauth/token` || !(expected.oauthScope in oauth.scopes)) throw new Error(`${expected.key} captured card OAuth mismatch`)
  if (!parsed.security.some((entry) => entry.oauth2?.includes(expected.oauthScope) === true)) throw new Error(`${expected.key} captured card security binding mismatch`)
}

function verifyRegistrationBody(input: unknown, agentId: number): void {
  const parsed = registrationProof.parse(input)
  const registry = "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e"
  if (!parsed.registrations.some((entry) => entry.agentId === agentId && entry.agentRegistry === registry)) throw new Error("captured registration identity mismatch")
}

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
