import { z } from "zod"

const utc = z.iso.datetime()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const httpsUrl = z.url().refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
}, "URL must use HTTPS without embedded credentials")
const measuredResponse = z.object({ url: httpsUrl, httpStatus: z.number().int().min(100).max(599), latencyMs: z.number().int().positive().max(30_000) }).strict()
export const tunnelCapturedResponseSchema = measuredResponse.extend({
  httpStatus: z.literal(200),
  sha256: digest,
  byteLength: z.number().int().positive().max(1_048_576),
  bodyBase64: z.string().min(4).max(1_398_104).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict()
const serviceSnapshot = z.object({
  unitId: z.literal("cloudflared.service"),
  names: z.array(z.string().regex(/^[A-Za-z0-9@_.-]+$/)).min(1).max(8),
  description: z.string().regex(/^[A-Za-z0-9 ()_.-]{1,200}$/),
  loadState: z.literal("loaded"),
  activeState: z.literal("active"),
  subState: z.literal("running"),
  unitFileState: z.literal("enabled"),
  restartPolicy: z.enum(["on-success", "on-failure", "on-abnormal", "on-watchdog", "on-abort", "always", "debug"]),
  restartDelay: z.string().regex(/^\d+(?:us|ms|s|min|h)?$/),
  startLimitInterval: z.string().regex(/^\d+(?:us|ms|s|min|h)?$/),
  startLimitBurst: z.number().int().nonnegative(),
  automaticRestartCount: z.number().int().nonnegative(),
  mainPid: z.number().int().positive(),
  invocationId: z.string().regex(/^[0-9a-f]{32}$/),
  activeEnterTimestampMonotonicMicros: z.string().regex(/^[1-9]\d*$/),
  result: z.literal("success"),
}).strict()
const containerSnapshot = z.object({
  key: z.enum(["healthguard", "rangepilot", "gridquant", "yieldscout"]),
  name: z.string().min(1),
  imageReference: z.string().min(1),
  immutableImageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  startedAtUtc: utc,
  running: z.literal(true),
  health: z.literal("healthy"),
}).strict()
const sellerProbe = z.object({
  key: z.enum(["healthguard", "rangepilot", "gridquant", "yieldscout"]),
  agentId: z.number().int().positive(),
  agentCard: tunnelCapturedResponseSchema,
  domainRegistration: tunnelCapturedResponseSchema,
  unauthenticatedInvocation: measuredResponse.extend({ httpStatus: z.literal(401) }).strict(),
}).strict()
export const tunnelPublicSnapshotSchema = z.object({
  requestNonce: z.string().regex(/^[0-9a-f]{32}$/),
  observedAtUtc: utc,
  completedAtUtc: utc,
  apiHealth: tunnelCapturedResponseSchema,
  sellers: z.array(sellerProbe).length(4),
  retainedArtifact: z.object({
    sellerKey: z.literal("healthguard"),
    expectedSha256: z.literal("581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2"),
    response: tunnelCapturedResponseSchema,
  }).strict(),
}).strict()

export const tunnelRecoveryLimitations = [
  "One operator-triggered cloudflared service restart is measured; repeatability is not established.",
  "The VPS, Docker daemon, KNOT containers, database, and object store are not restarted.",
  "One client location and point-in-time HTTP probes do not establish uptime, an SLA, failover, load capacity, host recovery, or regional availability.",
  "The API database state is its self-reported health value, not an independent database integrity check.",
  "No authenticated seller request, commerce mutation, chain RPC request, transaction submission, mainnet write, or fund transfer is performed.",
  "Network traffic is not instrumented, so no claim is made about every background process request.",
] as const

export const tunnelRecoveryEvidenceSchema = z.object({
  schemaVersion: z.literal("knot.tunnel-recovery-evidence/1"),
  observedFromUtc: utc,
  observedUntilUtc: utc,
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  result: z.literal("RECOVERED"),
  drill: z.object({
    mode: z.literal("controlled-cloudflared-service-restart"),
    command: z.literal("npm run tunnel:drill -- --execute"),
    targetUnit: z.literal("cloudflared.service"),
    recoveryTimeoutMs: z.literal(120_000),
    pollIntervalMs: z.literal(1_000),
    httpRequestTimeoutMs: z.literal(10_000),
    recoveryProbeAttempts: z.number().int().positive().max(120),
  }).strict(),
  boundary: z.object({
    explicitExecutionFlag: z.literal(true), sshBatchMode: z.literal(true), remoteMutationCommands: z.tuple([z.literal("systemctl restart cloudflared")]), remoteMutationCommandCount: z.literal(1),
    dockerMutationCommands: z.literal(0), containerRestartCommands: z.literal(0), dockerDaemonRestarted: z.literal(false), vpsRestarted: z.literal(false), authenticatedSellerRequests: z.literal(0),
    commerceMutationCommands: z.literal(0), chainRpcRequests: z.literal(0), transactionSubmissions: z.literal(0), mainnetWriteCommands: z.literal(0), fundTransferCommands: z.literal(0), networkTrafficInstrumented: z.literal(false),
  }).strict(),
  serviceBefore: serviceSnapshot,
  serviceAfter: serviceSnapshot,
  containersBefore: z.array(containerSnapshot).length(4),
  containersAfter: z.array(containerSnapshot).length(4),
  publicBefore: tunnelPublicSnapshotSchema,
  publicAfter: tunnelPublicSnapshotSchema,
  timing: z.object({
    restartRequestedAtUtc: utc, restartCommandCompletedAtUtc: utc, completePublicRecoveryAtUtc: utc,
    restartToCompletePublicRecoveryMs: z.number().int().positive().max(120_000),
  }).strict(),
  limitations: z.tuple(tunnelRecoveryLimitations.map((item) => z.literal(item)) as [z.ZodLiteral<string>, ...z.ZodLiteral<string>[]]),
}).strict()

export type TunnelRecoveryEvidence = z.infer<typeof tunnelRecoveryEvidenceSchema>
export type TunnelPublicSnapshot = z.infer<typeof tunnelPublicSnapshotSchema>
