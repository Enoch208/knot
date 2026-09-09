import { createHash } from "node:crypto"
import { z } from "zod"
import { expectedPublicSellers } from "../../discovery/src/public-sellers.ts"
import { tunnelCapturedResponseSchema, tunnelRecoveryEvidenceSchema, tunnelRecoveryLimitations, type TunnelRecoveryEvidence, type TunnelPublicSnapshot } from "./tunnel-recovery-schema.ts"

export { tunnelRecoveryEvidenceSchema, tunnelRecoveryLimitations, tunnelPublicSnapshotSchema, type TunnelRecoveryEvidence, type TunnelPublicSnapshot } from "./tunnel-recovery-schema.ts"

const expectedContainers = new Map([
  ["healthguard", "knot-healthguard-agent-1"],
  ["rangepilot", "knot-rangepilot-agent-1"],
  ["gridquant", "knot-gridquant-agent-1"],
  ["yieldscout", "knot-yieldscout-agent-1"],
])
const artifactUrl = "https://knot-artifacts.truematchx.com/knot-deliverables/healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json"

export function verifyTunnelRecoveryEvidence(input: unknown): TunnelRecoveryEvidence {
  const evidence = tunnelRecoveryEvidenceSchema.parse(input)
  const requested = Date.parse(evidence.timing.restartRequestedAtUtc)
  const commandCompleted = Date.parse(evidence.timing.restartCommandCompletedAtUtc)
  const recovered = Date.parse(evidence.timing.completePublicRecoveryAtUtc)
  if (Date.parse(evidence.observedFromUtc) !== Date.parse(evidence.publicBefore.observedAtUtc)) throw new Error("tunnel observation start does not match the before probe")
  if (Date.parse(evidence.observedUntilUtc) !== recovered || evidence.publicAfter.completedAtUtc !== evidence.timing.completePublicRecoveryAtUtc) throw new Error("tunnel observation end does not match complete public recovery")
  if (Date.parse(evidence.publicBefore.completedAtUtc) > requested || commandCompleted < requested || Date.parse(evidence.publicAfter.observedAtUtc) < commandCompleted || recovered < Date.parse(evidence.publicAfter.observedAtUtc)) throw new Error("tunnel recovery timing is not ordered")
  if (recovered - requested !== evidence.timing.restartToCompletePublicRecoveryMs) throw new Error("tunnel recovery duration does not match timestamps")
  if (evidence.publicBefore.requestNonce === evidence.publicAfter.requestNonce) throw new Error("before and after probes must use distinct cache-busting nonces")
  verifyServiceTransition(evidence)
  verifyContainerContinuity(evidence)
  verifyTunnelPublicSnapshot(evidence.publicBefore)
  verifyTunnelPublicSnapshot(evidence.publicAfter)
  for (const snapshot of [evidence.publicBefore, evidence.publicAfter]) {
    const latencies = [
      snapshot.apiHealth.latencyMs,
      snapshot.retainedArtifact.response.latencyMs,
      ...snapshot.sellers.flatMap((seller) => [seller.agentCard.latencyMs, seller.domainRegistration.latencyMs, seller.unauthenticatedInvocation.latencyMs]),
    ]
    const maximumLatencyMs = Math.max(...latencies)
    if (maximumLatencyMs > evidence.drill.httpRequestTimeoutMs) throw new Error("public recovery request latency exceeds the configured timeout")
    if (Date.parse(snapshot.observedAtUtc) + maximumLatencyMs > Date.parse(snapshot.completedAtUtc) + 250) throw new Error("public recovery request latency exceeds its capture window")
  }
  if (evidence.publicBefore.retainedArtifact.response.sha256 !== evidence.publicAfter.retainedArtifact.response.sha256) throw new Error("retained artifact changed across tunnel restart")
  return evidence
}

export function verifyTunnelPublicSnapshot(snapshot: TunnelPublicSnapshot): void {
  if (Date.parse(snapshot.completedAtUtc) < Date.parse(snapshot.observedAtUtc)) throw new Error("public probe timestamps are not ordered")
  const api = decodeJson(snapshot.apiHealth)
  const apiHealth = z.object({ service: z.literal("knot-api"), status: z.literal("AVAILABLE"), dependencies: z.object({ database: z.literal("AVAILABLE") }).passthrough() }).passthrough().parse(api)
  if (apiHealth.dependencies.database !== "AVAILABLE") throw new Error("database did not report AVAILABLE")
  const expectedOrder = expectedPublicSellers.map((seller) => seller.key)
  if (snapshot.sellers.map((seller) => seller.key).join(",") !== expectedOrder.join(",")) throw new Error("public probe seller order is incomplete")
  for (const observed of snapshot.sellers) verifySellerProbe(observed, snapshot.requestNonce)
  verifyProbeUrl(snapshot.apiHealth.url, "https://knot-api.truematchx.com/health", snapshot.requestNonce)
  verifyProbeUrl(snapshot.retainedArtifact.response.url, artifactUrl, snapshot.requestNonce)
  decodeBody(snapshot.retainedArtifact.response)
  if (snapshot.retainedArtifact.response.sha256 !== snapshot.retainedArtifact.expectedSha256) throw new Error("retained artifact digest mismatch")
}

export interface TunnelDrillInvocation {
  sshHost: string
  outputPath: string
}

export interface TunnelRecoverySummary {
  recoveryDurationMs: number
  recoveryProbeAttempts: number
  recoveryTimeoutMs: number
  sellerContainerCount: number
  retainedArtifactSha256: string
}

export function deriveTunnelRecoverySummary(evidence: TunnelRecoveryEvidence): TunnelRecoverySummary {
  return {
    recoveryDurationMs: evidence.timing.restartToCompletePublicRecoveryMs,
    recoveryProbeAttempts: evidence.drill.recoveryProbeAttempts,
    recoveryTimeoutMs: evidence.drill.recoveryTimeoutMs,
    sellerContainerCount: evidence.containersAfter.length,
    retainedArtifactSha256: evidence.publicAfter.retainedArtifact.response.sha256,
  }
}

export function tunnelRecoveryClaimText(summary: TunnelRecoverySummary): string {
  return `In one operator-triggered Cloudflare tunnel service restart, complete public recovery was verified ${formatInteger(summary.recoveryDurationMs)} ms after the restart request: the KNOT API and database reported AVAILABLE, all four seller cards and registration proofs returned HTTP 200, unauthenticated seller invocations returned HTTP 401, and all four seller container image IDs and start times remained unchanged.`
}

export function tunnelRecoveryReadmeText(summary: TunnelRecoverySummary): string {
  return `A controlled [Cloudflare tunnel recovery drill](evidence/operations/tunnel-recovery-20260909.json) issued one remote mutation: \`systemctl restart cloudflared\`. Complete public recovery was verified after \`${formatInteger(summary.recoveryDurationMs)} ms\`: the API and database reported \`AVAILABLE\`, all four identity-bearing seller cards and registration proofs returned HTTP 200, unauthenticated invocation remained HTTP 401, the retained artifact matched \`${summary.retainedArtifactSha256}\`, and all four seller container image IDs and start times remained unchanged. This is one operator-recorded service restart, not evidence of uptime, an SLA, failover, load capacity, host recovery, or regional availability.`
}

export function tunnelRecoveryReproduceText(summary: TunnelRecoverySummary): string {
  return `The published record measured \`${formatInteger(summary.recoveryDurationMs)} ms\` from restart request to complete public recovery in one attempt within its \`${formatInteger(summary.recoveryTimeoutMs)} ms\` bound.`
}

export function verifyTunnelRecoveryPublicationBindings(evidenceInput: unknown, claimInput: unknown, readme: string, reproduce: string): TunnelRecoverySummary {
  const evidence = verifyTunnelRecoveryEvidence(evidenceInput)
  const summary = deriveTunnelRecoverySummary(evidence)
  const claim = z.object({
    id: z.literal("cloudflared-controlled-recovery"),
    claim: z.string(),
    status: z.literal("SUPPORTED"),
    evidenceClasses: z.tuple([z.literal("publisher_claim")]),
    observationWindow: z.object({ fromUtc: z.iso.datetime(), toUtc: z.iso.datetime() }).strict(),
    scope: z.object({
      drillMode: z.literal("controlled-cloudflared-service-restart"), serviceUnit: z.literal("cloudflared.service"), recoveryDurationMs: z.number().int(), recoveryProbeAttempts: z.number().int(), recoveryTimeoutMs: z.number().int(), httpRequestTimeoutMs: z.number().int(),
      serviceStateAfter: z.literal("active/running"), unitFileStateAfter: z.literal("enabled"), restartPolicy: z.string(), restartDelay: z.string(), serviceInvocationChanged: z.literal(true), sellerContainerCount: z.number().int(), sellerContainersUnchanged: z.literal(true),
      apiHealthHttpStatus: z.literal(200), apiStatus: z.literal("AVAILABLE"), databaseStatus: z.literal("AVAILABLE"), sellerCardHttpStatus: z.literal(200), registrationProofHttpStatus: z.literal(200), unauthenticatedInvocationHttpStatus: z.literal(401), retainedArtifactSha256: z.string(),
      onlyRemoteMutation: z.literal("systemctl restart cloudflared"), remoteMutationCommandCount: z.literal(1), authenticatedSellerRequests: z.literal(0), commerceMutationCommands: z.literal(0), chainRpcRequests: z.literal(0), transactionSubmissions: z.literal(0), mainnetWriteCommands: z.literal(0), fundTransferCommands: z.literal(0),
    }).strict(),
    sources: z.array(z.object({ type: z.string() }).passthrough()),
    limitations: z.array(z.string()),
  }).passthrough().parse(claimInput)
  if (claim.claim !== tunnelRecoveryClaimText(summary)) throw new Error("tunnel recovery claim text does not match captured evidence")
  if (claim.observationWindow.fromUtc !== evidence.observedFromUtc || claim.observationWindow.toUtc !== evidence.observedUntilUtc) throw new Error("tunnel recovery publication window does not match captured evidence")
  const expectedScope = {
    drillMode: evidence.drill.mode, serviceUnit: evidence.serviceAfter.unitId, recoveryDurationMs: summary.recoveryDurationMs, recoveryProbeAttempts: summary.recoveryProbeAttempts, recoveryTimeoutMs: summary.recoveryTimeoutMs, httpRequestTimeoutMs: evidence.drill.httpRequestTimeoutMs,
    serviceStateAfter: `${evidence.serviceAfter.activeState}/${evidence.serviceAfter.subState}`, unitFileStateAfter: evidence.serviceAfter.unitFileState, restartPolicy: evidence.serviceAfter.restartPolicy, restartDelay: evidence.serviceAfter.restartDelay, serviceInvocationChanged: evidence.serviceBefore.invocationId !== evidence.serviceAfter.invocationId, sellerContainerCount: summary.sellerContainerCount, sellerContainersUnchanged: true,
    apiHealthHttpStatus: evidence.publicAfter.apiHealth.httpStatus, apiStatus: "AVAILABLE", databaseStatus: "AVAILABLE", sellerCardHttpStatus: 200, registrationProofHttpStatus: 200, unauthenticatedInvocationHttpStatus: 401, retainedArtifactSha256: summary.retainedArtifactSha256,
    onlyRemoteMutation: evidence.boundary.remoteMutationCommands[0], remoteMutationCommandCount: evidence.boundary.remoteMutationCommandCount, authenticatedSellerRequests: evidence.boundary.authenticatedSellerRequests, commerceMutationCommands: evidence.boundary.commerceMutationCommands, chainRpcRequests: evidence.boundary.chainRpcRequests, transactionSubmissions: evidence.boundary.transactionSubmissions, mainnetWriteCommands: evidence.boundary.mainnetWriteCommands, fundTransferCommands: evidence.boundary.fundTransferCommands,
  }
  if (JSON.stringify(claim.scope) !== JSON.stringify(expectedScope)) throw new Error("tunnel recovery claim scope does not match captured evidence")
  if (JSON.stringify(claim.limitations) !== JSON.stringify(tunnelRecoveryLimitations)) throw new Error("tunnel recovery claim limitations do not match captured evidence")
  const deployment = claim.sources.find((source) => source.type === "deployment_evidence")
  const command = claim.sources.find((source) => source.type === "repository_command")
  if (deployment?.path !== "evidence/operations/tunnel-recovery-20260909.json") throw new Error("tunnel recovery claim does not bind the captured evidence path")
  if (command?.path !== "scripts/verify-tunnel-recovery.ts" || command.command !== "npm run tunnel:verify -- evidence/operations/tunnel-recovery-20260909.json" || command.observedStatus !== "VERIFIED_CONTROLLED_TUNNEL_RECOVERY") throw new Error("tunnel recovery claim does not bind the verifier result")
  if (!readme.includes(tunnelRecoveryReadmeText(summary))) throw new Error("tunnel recovery README text does not match captured evidence")
  if (!reproduce.includes(tunnelRecoveryReproduceText(summary))) throw new Error("tunnel recovery reproduction text does not match captured evidence")
  return summary
}

export function parseTunnelDrillInvocation(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): TunnelDrillInvocation {
  let executeSeen = false
  let outputSeen = false
  let outputPath = ".secrets/reliability/tunnel-recovery-latest.json"
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--execute" && !executeSeen) {
      executeSeen = true
      continue
    }
    if (argument === "--output" && !outputSeen) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--output requires a path")
      outputPath = value
      outputSeen = true
      index += 1
      continue
    }
    throw new Error(`unsupported or duplicate tunnel drill argument: ${argument ?? "missing"}`)
  }
  if (!executeSeen) throw new Error("tunnel recovery drill requires explicit --execute")
  const sshHost = environment.KNOT_RELIABILITY_SSH_HOST ?? ""
  if (!/^(?:[A-Za-z_][A-Za-z0-9_-]{0,31}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(sshHost)) throw new Error("KNOT_RELIABILITY_SSH_HOST is required and must be a plain SSH destination")
  if (!/^(?:\.secrets\/reliability\/[a-z0-9][a-z0-9-]*\.json|evidence\/operations\/tunnel-recovery-\d{8}\.json)$/.test(outputPath)) throw new Error("tunnel recovery output path is not allowlisted")
  return { sshHost, outputPath }
}

function verifyServiceTransition(evidence: TunnelRecoveryEvidence): void {
  const before = evidence.serviceBefore
  const after = evidence.serviceAfter
  if (!before.names.includes(before.unitId) || !after.names.includes(after.unitId)) throw new Error("systemd service identity omits the target unit")
  for (const key of ["unitId", "description", "unitFileState", "restartPolicy", "restartDelay", "startLimitInterval", "startLimitBurst"] as const) {
    if (before[key] !== after[key]) throw new Error(`cloudflared ${key} changed during the drill`)
  }
  if (before.names.join(",") !== after.names.join(",")) throw new Error("cloudflared service names changed during the drill")
  if (before.invocationId === after.invocationId || before.mainPid === after.mainPid) throw new Error("cloudflared did not record a new service invocation")
  if (BigInt(after.activeEnterTimestampMonotonicMicros) <= BigInt(before.activeEnterTimestampMonotonicMicros)) throw new Error("cloudflared active-enter timestamp did not advance")
}

function verifyContainerContinuity(evidence: TunnelRecoveryEvidence): void {
  const expectedOrder = [...expectedContainers.keys()]
  for (const snapshots of [evidence.containersBefore, evidence.containersAfter]) {
    if (snapshots.map((snapshot) => snapshot.key).join(",") !== expectedOrder.join(",")) throw new Error("container snapshot order is incomplete")
  }
  for (const [index, before] of evidence.containersBefore.entries()) {
    const after = evidence.containersAfter[index]
    if (after === undefined || before.name !== expectedContainers.get(before.key) || after.name !== before.name) throw new Error(`${before.key} container identity mismatch`)
    if (!before.imageReference.startsWith(`knot/${before.key}:`) || after.imageReference !== before.imageReference) throw new Error(`${before.key} image reference changed across tunnel restart`)
    if (after.immutableImageId !== before.immutableImageId || after.startedAtUtc !== before.startedAtUtc) throw new Error(`${before.key} container restarted during tunnel recovery`)
  }
}

function verifySellerProbe(observed: TunnelPublicSnapshot["sellers"][number], nonce: string): void {
  const expected = expectedPublicSellers.find((seller) => seller.key === observed.key)
  if (expected === undefined || observed.agentId !== expected.agentId) throw new Error(`unexpected seller identity for ${observed.key}`)
  verifyProbeUrl(observed.agentCard.url, `${expected.origin}/.well-known/agent-card.json`, nonce)
  verifyProbeUrl(observed.domainRegistration.url, `${expected.origin}/.well-known/agent-registration.json`, nonce)
  verifyProbeUrl(observed.unauthenticatedInvocation.url, `${expected.origin}/`, nonce)
  const card = z.object({
    name: z.literal(expected.cardName), url: z.literal(`${expected.origin}/`), protocolVersion: z.literal("0.3.0"), preferredTransport: z.literal("JSONRPC"),
    skills: z.array(z.object({ id: z.string() }).passthrough()),
    securitySchemes: z.object({ oauth2: z.object({ flows: z.object({ clientCredentials: z.object({ tokenUrl: z.literal(`${expected.origin}/oauth/token`), scopes: z.record(z.string(), z.string()) }).passthrough() }).passthrough() }).passthrough() }).passthrough(),
    security: z.array(z.record(z.string(), z.array(z.string()))),
  }).passthrough().parse(decodeJson(observed.agentCard))
  const skills = new Set(card.skills.map((skill) => skill.id))
  if (!skills.has("negotiate") || !skills.has("notify_funded") || !(expected.oauthScope in card.securitySchemes.oauth2.flows.clientCredentials.scopes)) throw new Error(`${observed.key} card capability mismatch`)
  if (!card.security.some((entry) => entry.oauth2?.includes(expected.oauthScope) === true)) throw new Error(`${observed.key} card security binding mismatch`)
  const proof = z.object({ registrations: z.array(z.object({ agentId: z.number().int(), agentRegistry: z.string() }).strict()) }).strict().parse(decodeJson(observed.domainRegistration))
  const registry = "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e"
  if (!proof.registrations.some((entry) => entry.agentId === expected.agentId && entry.agentRegistry === registry)) throw new Error(`${observed.key} registration identity mismatch`)
}

function verifyProbeUrl(actual: string, canonical: string, nonce: string): void {
  const expected = new URL(canonical)
  expected.searchParams.set("tunnel-recovery", nonce)
  if (actual !== expected.toString()) throw new Error(`unexpected tunnel probe URL: ${actual}`)
}

function decodeJson(response: z.infer<typeof tunnelCapturedResponseSchema>): unknown {
  const text = Buffer.from(decodeBody(response)).toString("utf8")
  try { return JSON.parse(text) as unknown } catch { throw new Error("captured tunnel response is not JSON") }
}

function decodeBody(response: z.infer<typeof tunnelCapturedResponseSchema>): Uint8Array {
  const bytes = Buffer.from(response.bodyBase64, "base64")
  if (bytes.toString("base64") !== response.bodyBase64) throw new Error("captured tunnel response is not canonical base64")
  if (bytes.byteLength !== response.byteLength) throw new Error("captured tunnel response length mismatch")
  if (createHash("sha256").update(bytes).digest("hex") !== response.sha256) throw new Error("captured tunnel response hash mismatch")
  return bytes
}

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
