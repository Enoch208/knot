import { z } from "zod"

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const isoTime = z.string().datetime({ offset: true })
const url = z.string().url()

const fetchedResourceSchema = z.object({
  url,
  httpStatus: z.literal(200),
  sha256: digest,
  byteLength: z.number().int().positive(),
}).strict()

const artifactSchema = fetchedResourceSchema.extend({
  expectedSha256: digest,
}).strict()

const publicSurfaceSchema = z.object({
  agentCard: fetchedResourceSchema,
  domainRegistration: fetchedResourceSchema,
  unauthenticatedInvocationHttpStatus: z.literal(401),
  retainedArtifact: artifactSchema,
}).strict()

const sellerSchema = z.object({
  key: z.enum(["healthguard", "rangepilot", "gridquant", "yieldscout"]),
  category: z.enum(["health", "rebalancing", "grid", "yield"]),
  hostname: z.string().min(1),
  agentId: z.string().regex(/^\d+$/),
  image: z.object({
    reference: z.string().min(1),
    immutableIdBefore: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    immutableIdAfter: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    unchanged: z.literal(true),
  }).strict(),
  container: z.object({
    startedAtBeforeUtc: isoTime,
    startedAtAfterUtc: isoTime,
    healthBefore: z.literal("healthy"),
    healthAfter: z.literal("healthy"),
    restartPolicy: z.literal("unless-stopped"),
    readOnlyRootFilesystem: z.literal(true),
    capDropAll: z.literal(true),
    noNewPrivileges: z.literal(true),
  }).strict(),
  timing: z.object({
    restartRequestedAtUtc: isoTime,
    restartCommandCompletedAtUtc: isoTime,
    recoveredAtUtc: isoTime,
    recoveryDurationMs: z.number().int().positive(),
  }).strict(),
  publicSurfaceBefore: publicSurfaceSchema,
  publicSurfaceAfter: publicSurfaceSchema,
  authenticatedQuoteAfter: z.object({
    tokenHttpStatus: z.literal(200),
    invocationHttpStatus: z.literal(200),
    accepted: z.literal(true),
    providerSignaturePresent: z.literal(true),
    chainId: z.literal(97),
    verifyingContract: z.string().regex(/^0x[0-9a-f]{40}$/),
  }).strict(),
}).strict()

export const sellerRecoveryEvidenceSchema = z.object({
  schemaVersion: z.literal("knot.seller-recovery-evidence/1"),
  observedAtUtc: isoTime,
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  drill: z.object({
    mode: z.literal("sequential-container-restart"),
    command: z.literal("npm run reliability:drill -- --execute"),
    serverRole: z.literal("KNOT seller VPS"),
  }).strict(),
  boundary: z.object({
    onlyStateChangingOperation: z.literal("seller-container-restart"),
    dockerDaemonRestarted: z.literal(false),
    vpsRestarted: z.literal(false),
    cloudflaredRestarted: z.literal(false),
    networkTrafficInstrumented: z.literal(false),
    commerceMutationCommands: z.literal(0),
    mainnetWriteCommands: z.literal(0),
    fundTransferCommands: z.literal(0),
  }).strict(),
  sellers: z.array(sellerSchema).length(4),
  limitations: z.array(z.string().min(1)).min(4),
}).strict()

export type SellerRecoveryEvidence = z.infer<typeof sellerRecoveryEvidenceSchema>

const expected = new Map([
  ["healthguard", { category: "health", hostname: "knot-health.truematchx.com", agentId: "2295", cardSha256: "c5cde2e972ac97d42404705f59a3dc46a2c7b73b650f9334a7642f90e3889f02", cardByteLength: 2001, proofSha256: "9fcb73bd3e94950dfc6ee7aac2d32830981b20d22fd250d40776e62b8706e9a7", proofByteLength: 107 }],
  ["rangepilot", { category: "rebalancing", hostname: "knot-range.truematchx.com", agentId: "2297", cardSha256: "85a35077d4e1dc9f4f29c984d430b2ad4c56b744343656116e81194d6d693c1b", cardByteLength: 2063, proofSha256: "6ea12e02d16b0250c06917ea3c42dd0a01787a19c2d91b5234728bc2ffdadfd8", proofByteLength: 107 }],
  ["gridquant", { category: "grid", hostname: "knot-grid.truematchx.com", agentId: "2298", cardSha256: "c5af638a0e205f66a8a8e6d6ef7456455b932324a5eab2018f78927fce7900ef", cardByteLength: 2069, proofSha256: "02ecc799ed387960db6dfc8ef96fca84ed5548e074b8f42be1b6e16b320a0c4b", proofByteLength: 107 }],
  ["yieldscout", { category: "yield", hostname: "knot-yield.truematchx.com", agentId: "2299", cardSha256: "d2990b63fdccad90d77ed4ab57fd5eee96dfb491059d281a8e870aca6e74aee2", cardByteLength: 2093, proofSha256: "7e28d2844d8b35aa6516a3af995d7c7c601124e1ccb44f3bc6ac7d19137eb12b", proofByteLength: 107 }],
])
const expectedSellerOrder = ["healthguard", "rangepilot", "gridquant", "yieldscout"] as const

export const verifySellerRecoveryEvidence = (input: unknown): SellerRecoveryEvidence => {
  const evidence = sellerRecoveryEvidenceSchema.parse(input)
  const keys = new Set(evidence.sellers.map((seller) => seller.key))
  if (keys.size !== expected.size) throw new Error("seller recovery evidence must contain every seller exactly once")
  for (const [index, seller] of evidence.sellers.entries()) {
    if (seller.key !== expectedSellerOrder[index]) throw new Error(`seller recovery evidence order mismatch at position ${index + 1}`)
    const identity = expected.get(seller.key)
    if (identity === undefined || seller.category !== identity.category || seller.hostname !== identity.hostname || seller.agentId !== identity.agentId) {
      throw new Error(`unexpected seller identity for ${seller.key}`)
    }
    if (seller.image.immutableIdBefore !== seller.image.immutableIdAfter || !seller.image.unchanged) throw new Error(`${seller.key} image changed during restart`)
    if (!seller.image.reference.startsWith(`knot/${seller.key}:`)) throw new Error(`${seller.key} image reference mismatch`)
    const startedBefore = Date.parse(seller.container.startedAtBeforeUtc)
    const startedAfter = Date.parse(seller.container.startedAtAfterUtc)
    const requested = Date.parse(seller.timing.restartRequestedAtUtc)
    const commandCompleted = Date.parse(seller.timing.restartCommandCompletedAtUtc)
    const recovered = Date.parse(seller.timing.recoveredAtUtc)
    const previous = evidence.sellers[index - 1]
    if (previous !== undefined && Date.parse(previous.timing.recoveredAtUtc) > requested) throw new Error(`${seller.key} restart overlaps preceding seller recovery`)
    if (startedAfter <= startedBefore || startedAfter < requested || startedAfter > recovered) throw new Error(`${seller.key} did not record a new container start`)
    if (commandCompleted < requested || commandCompleted > recovered) throw new Error(`${seller.key} restart timing is not ordered`)
    const elapsed = Date.parse(seller.timing.recoveredAtUtc) - Date.parse(seller.timing.restartRequestedAtUtc)
    if (elapsed !== seller.timing.recoveryDurationMs) throw new Error(`${seller.key} recovery duration does not match timestamps`)
    for (const surface of [seller.publicSurfaceBefore, seller.publicSurfaceAfter]) {
      if (surface.agentCard.url !== `https://${seller.hostname}/.well-known/agent-card.json`) throw new Error(`${seller.key} card URL mismatch`)
      if (surface.domainRegistration.url !== `https://${seller.hostname}/.well-known/agent-registration.json`) throw new Error(`${seller.key} registration URL mismatch`)
      if (surface.agentCard.sha256 !== identity.cardSha256 || surface.agentCard.byteLength !== identity.cardByteLength) throw new Error(`${seller.key} card body does not match its identity-verified release`)
      if (surface.domainRegistration.sha256 !== identity.proofSha256 || surface.domainRegistration.byteLength !== identity.proofByteLength) throw new Error(`${seller.key} registration body does not match its identity-verified release`)
      const artifactUrl = new URL(surface.retainedArtifact.url)
      if (artifactUrl.origin !== "https://knot-artifacts.truematchx.com" || artifactUrl.pathname !== `/knot-deliverables/${seller.key}/sha256/${surface.retainedArtifact.expectedSha256}.json`) throw new Error(`${seller.key} retained artifact URL mismatch`)
      if (surface.retainedArtifact.sha256 !== surface.retainedArtifact.expectedSha256) throw new Error(`${seller.key} retained artifact digest mismatch`)
    }
    if (seller.publicSurfaceBefore.agentCard.sha256 !== seller.publicSurfaceAfter.agentCard.sha256 || seller.publicSurfaceBefore.agentCard.byteLength !== seller.publicSurfaceAfter.agentCard.byteLength) throw new Error(`${seller.key} card changed during restart`)
    if (seller.publicSurfaceBefore.domainRegistration.sha256 !== seller.publicSurfaceAfter.domainRegistration.sha256 || seller.publicSurfaceBefore.domainRegistration.byteLength !== seller.publicSurfaceAfter.domainRegistration.byteLength) throw new Error(`${seller.key} registration changed during restart`)
    if (seller.publicSurfaceBefore.retainedArtifact.sha256 !== seller.publicSurfaceAfter.retainedArtifact.sha256) throw new Error(`${seller.key} artifact changed during restart`)
    if (seller.authenticatedQuoteAfter.verifyingContract !== "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de") throw new Error(`${seller.key} quote contract mismatch`)
  }
  return evidence
}

export interface SellerRecoverySummary {
  recoveryDurationMs: Record<"healthguard" | "rangepilot" | "gridquant" | "yieldscout", number>
  maximumRecoveryDurationMs: number
}

export function deriveSellerRecoverySummary(evidence: SellerRecoveryEvidence): SellerRecoverySummary {
  const durations = Object.fromEntries(evidence.sellers.map((seller) => [seller.key, seller.timing.recoveryDurationMs])) as SellerRecoverySummary["recoveryDurationMs"]
  return { recoveryDurationMs: durations, maximumRecoveryDurationMs: Math.max(...Object.values(durations)) }
}

export function sellerRecoveryClaimText(): string {
  return "HealthGuard, RangePilot, GridQuant, and YieldScout each recovered from one controlled sequential container restart with the same immutable image and retained artifact bytes, restored public card and domain-proof responses, fail-closed unauthenticated invocation, and an authenticated BSC-testnet quote response containing a provider signature."
}

export function sellerRecoveryReadmeText(summary: SellerRecoverySummary): string {
  const duration = summary.recoveryDurationMs
  return `A controlled [seller recovery drill](evidence/operations/seller-recovery-20260909.json) restarted HealthGuard, RangePilot, GridQuant, and YieldScout one at a time. Each returned healthy on the same immutable image, restored its public card and domain proof, continued to reject unauthenticated invocation with HTTP 401, returned an authenticated BSC testnet quote response containing a provider signature, and served the exact retained artifact bytes. Measured restart-to-recovery times were \`${formatInteger(duration.healthguard)} ms\`, \`${formatInteger(duration.rangepilot)} ms\`, \`${formatInteger(duration.gridquant)} ms\`, and \`${formatInteger(duration.yieldscout)} ms\`, respectively. This was one container restart per seller using retained negotiate requests, not an uptime, failover, rollback, or SLA test.`
}

export function verifySellerRecoveryPublicationBindings(evidenceInput: unknown, claimInput: unknown, readme: string): SellerRecoverySummary {
  const evidence = verifySellerRecoveryEvidence(evidenceInput)
  const summary = deriveSellerRecoverySummary(evidence)
  const claim = z.object({
    id: z.literal("seller-restart-recovery"), claim: z.string(), status: z.literal("SUPPORTED"), evidenceClasses: z.tuple([z.literal("publisher_claim")]), observedAtUtc: isoTime,
    scope: z.object({
      drillMode: z.literal("sequential-container-restart"), sellerCount: z.literal(4), agentIds: z.array(z.string()).length(4), recoveryDurationMs: z.record(z.string(), z.number().int()), maximumRecoveryDurationMs: z.number().int(), restoredChecks: z.array(z.string()), quoteChainId: z.literal(97), onlyStateChangingOperation: z.literal("seller-container-restart"), networkTrafficInstrumented: z.literal(false), commerceMutationCommands: z.literal(0), mainnetWriteCommands: z.literal(0), fundTransferCommands: z.literal(0),
    }).strict(),
  }).passthrough().parse(claimInput)
  if (claim.claim !== sellerRecoveryClaimText()) throw new Error("seller recovery claim text does not match the evidence boundary")
  if (claim.observedAtUtc !== evidence.observedAtUtc) throw new Error("seller recovery claim timestamp does not match evidence")
  if (JSON.stringify(claim.scope.recoveryDurationMs) !== JSON.stringify(summary.recoveryDurationMs) || claim.scope.maximumRecoveryDurationMs !== summary.maximumRecoveryDurationMs) throw new Error("seller recovery claim durations do not match evidence")
  if (claim.scope.agentIds.join(",") !== evidence.sellers.map((seller) => seller.agentId).join(",")) throw new Error("seller recovery claim identities do not match evidence")
  if (claim.scope.sellerCount !== evidence.sellers.length || claim.scope.drillMode !== evidence.drill.mode || claim.scope.onlyStateChangingOperation !== evidence.boundary.onlyStateChangingOperation) throw new Error("seller recovery claim scope does not match evidence")
  if (claim.scope.networkTrafficInstrumented !== evidence.boundary.networkTrafficInstrumented || claim.scope.commerceMutationCommands !== evidence.boundary.commerceMutationCommands || claim.scope.mainnetWriteCommands !== evidence.boundary.mainnetWriteCommands || claim.scope.fundTransferCommands !== evidence.boundary.fundTransferCommands) throw new Error("seller recovery claim boundary does not match evidence")
  if (!readme.includes(sellerRecoveryReadmeText(summary))) throw new Error("seller recovery README values do not match evidence")
  return summary
}

export interface SellerRecoveryDrillInvocation {
  sshHost: string
  outputPath: string
}

export function parseSellerRecoveryDrillInvocation(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): SellerRecoveryDrillInvocation {
  if (argv.length !== 1 || argv[0] !== "--execute") throw new Error("seller recovery drill accepts exactly --execute")
  const sshHost = environment.KNOT_RELIABILITY_SSH_HOST ?? ""
  if (!/^(?:[A-Za-z_][A-Za-z0-9_-]{0,31}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(sshHost)) throw new Error("KNOT_RELIABILITY_SSH_HOST is required and must be a plain SSH destination")
  const outputPath = environment.KNOT_RELIABILITY_OUTPUT ?? ".secrets/reliability/seller-recovery-latest.json"
  const allowedOutputs = new Set([".secrets/reliability/seller-recovery-latest.json", "evidence/operations/seller-recovery-20260909.json"])
  if (!allowedOutputs.has(outputPath)) throw new Error("KNOT_RELIABILITY_OUTPUT is not allowlisted")
  return { sshHost, outputPath }
}

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}
