import { z } from "zod"

const utc = z.iso.datetime()
const digest = z.string().regex(/^0x[0-9a-f]{64}$/)
const address = z.string().regex(/^0x[0-9a-f]{40}$/)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/)
const publicChecks = [
  ["api", "https://knot-api.truematchx.com/health"],
  ["healthguard", "https://knot-health.truematchx.com/.well-known/agent-card.json"],
  ["rangepilot", "https://knot-range.truematchx.com/.well-known/agent-card.json"],
  ["gridquant", "https://knot-grid.truematchx.com/.well-known/agent-card.json"],
  ["yieldscout", "https://knot-yield.truematchx.com/.well-known/agent-card.json"],
] as const
const migrationSchema = z.tuple([
  z.literal("0001_domain.sql"),
  z.literal("0002_state_guards.sql"),
  z.literal("0003_product_records.sql"),
  z.literal("0004_chain_action_broadcast_unknown.sql"),
  z.literal("0005_chain_action_recovery.sql"),
  z.literal("0006_chain_action_intent.sql"),
  z.literal("0007_chain_action_binding_immutability.sql"),
])
const limitationSchema = z.tuple([
  z.literal("The deployed queue was empty, so no queued receipt observation, lease, reconciliation transition, recovery retry, or recovery effectiveness was exercised."),
  z.literal("One isolated in-memory known-hash probe observed an existing BSC testnet transaction through the deployed observer and safe read transport; it did not use the database, wallet, or queue."),
  z.literal("The receipt probe is one point-in-time testnet observation and does not establish repeatability, provider redundancy, reorg-after-terminal handling, or lost-hash recovery."),
  z.literal("The public checks and two worker samples do not establish uptime, an SLA, load capacity, regional availability, or host recovery."),
  z.literal("No transaction broadcaster or automatic resubmission path exists, and no chain write or fund transfer was performed."),
  z.literal("Relay and account-abstraction recovery remain outside scope."),
])
export const chainRecoveryRolloutLimitations = [
  "The deployed queue was empty, so no queued receipt observation, lease, reconciliation transition, recovery retry, or recovery effectiveness was exercised.",
  "One isolated in-memory known-hash probe observed an existing BSC testnet transaction through the deployed observer and safe read transport; it did not use the database, wallet, or queue.",
  "The receipt probe is one point-in-time testnet observation and does not establish repeatability, provider redundancy, reorg-after-terminal handling, or lost-hash recovery.",
  "The public checks and two worker samples do not establish uptime, an SLA, load capacity, regional availability, or host recovery.",
  "No transaction broadcaster or automatic resubmission path exists, and no chain write or fund transfer was performed.",
  "Relay and account-abstraction recovery remain outside scope.",
] as const

const workerSample = z.object({
  observedAtUtc: utc,
  activeJobs: z.literal(0),
  outboxEntries: z.literal(0),
  recovery: z.object({
    enabled: z.literal(true),
    claimed: z.literal(0),
    examined: z.literal(0),
    changed: z.literal(0),
    queueExhausted: z.literal(true),
    loadFailures: z.literal(0),
    reconcileFailures: z.literal(0),
  }).strict(),
}).strict()

export const chainRecoveryRolloutEvidenceSchema = z.object({
  schemaVersion: z.literal("knot.chain-recovery-rollout/1"),
  evidenceClasses: z.tuple([z.literal("publisher_claim"), z.literal("testnet_observation")]),
  rolloutCapturedAtUtc: z.literal("2026-09-09T18:33:48.000Z"),
  observedUntilUtc: z.literal("2026-09-09T18:34:54.046Z"),
  release: z.object({
    releaseTag: z.literal("35def38e730e"),
    imageReference: z.literal("knot/backend:35def38e730e"),
    immutableImageId: z.literal("sha256:e2f11219338b090a3b3e8cb6036ad9f7368bc4739ff7de68cca92d3ca4bb3d06"),
  }).strict(),
  services: z.tuple([
    z.object({ role: z.literal("api"), startedAtUtc: z.literal("2026-09-09T18:33:17.954585521Z"), health: z.literal("healthy") }).strict(),
    z.object({ role: z.literal("worker"), startedAtUtc: z.literal("2026-09-09T18:33:17.95530383Z"), health: z.literal("healthy") }).strict(),
  ]),
  configuration: z.object({
    secretFile: z.literal("/etc/knot/chain-read.env"),
    secretFileMode: z.literal("0600"),
    mountedServices: z.tuple([z.literal("worker")]),
    recoveryEnabled: z.literal(true),
    observerMode: z.literal("known-hash-read-only"),
    broadcasterPresent: z.literal(false),
  }).strict(),
  database: z.object({
    appliedMigrations: migrationSchema,
    chainActionCountAtRollout: z.literal(0),
    chainActionCountAfterProbe: z.literal(0),
  }).strict(),
  workerSamples: z.tuple([workerSample, workerSample]),
  publicChecks: z.tuple([
    z.object({ service: z.literal("api"), url: z.literal(publicChecks[0][1]), httpStatus: z.literal(200), applicationStatus: z.literal("AVAILABLE"), databaseStatus: z.literal("AVAILABLE") }).strict(),
    ...publicChecks.slice(1).map(([service, url]) => z.object({ service: z.literal(service), url: z.literal(url), httpStatus: z.literal(200) }).strict()),
  ] as const),
  receiptProbe: z.object({
    observedAtUtc: z.literal("2026-09-09T18:34:54.046Z"),
    status: z.literal("DEPLOYED_READ_ONLY_RECEIPT_OBSERVED"),
    executionContext: z.literal("in-memory invocation inside deployed worker image"),
    observer: z.literal("BscChainReceiptObserver"),
    transport: z.literal("SafeBscReadRpcTransport"),
    source: z.object({
      purpose: z.literal("external paid job 1203 fund transaction"),
      chainId: z.literal(97),
      transactionHash: digest,
      transactionIntentHash: z.literal("0x7d8eaa7f7f76482d3d38f618411a5a4af5294ea601df5c202a93bbde97966a7d"),
      signerAddress: address,
      nonce: z.literal("60"),
      status: z.literal("SUCCESS"),
      blockNumber: decimal,
      blockHash: digest,
      confirmations: z.literal(11022),
    }).strict(),
    databaseUsed: z.literal(false),
    walletUsed: z.literal(false),
    queueUsed: z.literal(false),
  }).strict(),
  boundary: z.object({
    queueReceiptRpcObservations: z.literal(0),
    oneShotKnownHashReceiptObservations: z.literal(1),
    recoveryTransitions: z.literal(0),
    databaseRowsCreated: z.literal(0),
    databaseRowsUpdated: z.literal(0),
    walletAccesses: z.literal(0),
    transactionBroadcasts: z.literal(0),
    chainWrites: z.literal(0),
    fundTransfers: z.literal(0),
    lostHashScans: z.literal(0),
  }).strict(),
  limitations: limitationSchema,
}).strict()

export type ChainRecoveryRolloutEvidence = z.infer<typeof chainRecoveryRolloutEvidenceSchema>

const externalJobReference = z.object({
  network: z.object({ chainId: z.literal(97) }).passthrough(),
  identity: z.object({ buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).passthrough(),
  transactions: z.object({ fund: z.object({ hash: digest, status: z.literal("success"), blockNumber: decimal, blockHash: digest }).passthrough() }).passthrough(),
}).passthrough()

export function verifyChainRecoveryRolloutEvidence(input: unknown, jobReferenceInput: unknown): ChainRecoveryRolloutEvidence {
  const evidence = chainRecoveryRolloutEvidenceSchema.parse(input)
  const job = externalJobReference.parse(jobReferenceInput)
  if (evidence.release.imageReference !== `knot/backend:${evidence.release.releaseTag}`) throw new Error("rollout image reference does not match release tag")
  const apiStarted = Date.parse(evidence.services[0].startedAtUtc)
  const workerStarted = Date.parse(evidence.services[1].startedAtUtc)
  const firstSample = Date.parse(evidence.workerSamples[0].observedAtUtc)
  const secondSample = Date.parse(evidence.workerSamples[1].observedAtUtc)
  const captured = Date.parse(evidence.rolloutCapturedAtUtc)
  const probed = Date.parse(evidence.receiptProbe.observedAtUtc)
  if (apiStarted > firstSample || workerStarted > firstSample || firstSample >= secondSample || secondSample > captured || captured >= probed) throw new Error("rollout timestamps are not ordered")
  if (secondSample - firstSample < 9_000 || secondSample - firstSample > 11_000) throw new Error("worker samples do not span the declared interval")
  if (evidence.workerSamples[0].observedAtUtc !== "2026-09-09T18:33:28.878609276Z" || evidence.workerSamples[1].observedAtUtc !== "2026-09-09T18:33:38.885620321Z") throw new Error("worker sample timestamps do not match the captured rollout")
  if (evidence.observedUntilUtc !== evidence.receiptProbe.observedAtUtc) throw new Error("rollout end does not match the receipt observation")
  const source = evidence.receiptProbe.source
  if (source.chainId !== job.network.chainId || source.signerAddress.toLowerCase() !== job.identity.buyer.toLowerCase()) throw new Error("receipt probe identity does not match job 1203")
  if (source.transactionHash !== job.transactions.fund.hash || source.blockNumber !== job.transactions.fund.blockNumber || source.blockHash !== job.transactions.fund.blockHash) throw new Error("receipt probe transaction does not match job 1203 funding")
  return evidence
}

export interface ChainRecoveryRolloutSummary {
  releaseTag: string
  immutableImageId: string
  workerSampleCount: number
  publicCheckCount: number
  receiptTransactionHash: string
  receiptBlockNumber: string
  receiptConfirmations: number
}

export function deriveChainRecoveryRolloutSummary(evidence: ChainRecoveryRolloutEvidence): ChainRecoveryRolloutSummary {
  return {
    releaseTag: evidence.release.releaseTag,
    immutableImageId: evidence.release.immutableImageId,
    workerSampleCount: evidence.workerSamples.length,
    publicCheckCount: evidence.publicChecks.length,
    receiptTransactionHash: evidence.receiptProbe.source.transactionHash,
    receiptBlockNumber: evidence.receiptProbe.source.blockNumber,
    receiptConfirmations: evidence.receiptProbe.source.confirmations,
  }
}

export function chainRecoveryRolloutClaimText(summary: ChainRecoveryRolloutSummary): string {
  return `The repository-tested no-resubmission recovery kernel was deployed behind an explicitly enabled read-only gate in release ${summary.releaseTag}. The API and worker were healthy, five public checks returned HTTP 200, and two worker samples saw an empty chain-action queue with zero claimed, examined, changed, or failed actions. A separate in-memory invocation inside the deployed worker image observed existing BSC testnet transaction ${summary.receiptTransactionHash} as SUCCESS at block ${summary.receiptBlockNumber} with ${summary.receiptConfirmations} confirmations through the known-hash observer; it did not use the database, wallet, queue, broadcaster, or any chain-write path.`
}

export function chainRecoveryRolloutReadmeText(summary: ChainRecoveryRolloutSummary): string {
  return `The [read-only recovery rollout](evidence/operations/chain-recovery-rollout-20260909.json) deployed release \`${summary.releaseTag}\` to the API and worker on the same immutable image \`${summary.immutableImageId}\`. Both containers were healthy, the recovery gate was explicitly enabled from a mode-\`0600\` environment mounted only into the worker, and all ${summary.publicCheckCount} API and seller-card checks returned HTTP 200. Two worker samples approximately ten seconds apart saw zero active jobs, outbox entries, or chain actions and zero claimed, examined, changed, or failed recovery actions. A separate in-memory probe inside that deployed worker image observed existing BSC testnet transaction \`${summary.receiptTransactionHash}\` as \`SUCCESS\` at block \`${summary.receiptBlockNumber}\` with \`${summary.receiptConfirmations}\` confirmations using the known-hash read-only observer. The probe did not use the database, wallet, queue, broadcaster, or a chain-write path. Because the deployed queue was empty, this is rollout, idle-loop, and one-shot receipt-read evidence—not an exercised queued recovery, retry, reorg, uptime, or recovery-effectiveness result.`
}

export function chainRecoveryRolloutReproduceText(): string {
  return "The offline verifier binds the sanitized release, immutable image, service starts, mode-`0600` worker-only gate, seven migrations, empty database and worker samples, five HTTP-200 checks, the one-shot job-1203 receipt observation, and every zero-write limitation. It does not repeat the deployment or RPC call and therefore verifies the captured record rather than proving uptime or queued recovery effectiveness."
}

export function verifyChainRecoveryRolloutPublicationBindings(evidenceInput: unknown, jobReferenceInput: unknown, claimInput: unknown, readme: string, reproduce: string): ChainRecoveryRolloutSummary {
  const evidence = verifyChainRecoveryRolloutEvidence(evidenceInput, jobReferenceInput)
  const summary = deriveChainRecoveryRolloutSummary(evidence)
  const claim = z.object({
    id: z.literal("chain-action-recovery-kernel"),
    claim: z.string(),
    status: z.literal("SUPPORTED"),
    evidenceClasses: z.tuple([z.literal("synthetic_fixture"), z.literal("publisher_claim"), z.literal("testnet_observation")]),
    scope: z.object({
      minimumLeaseMarginMilliseconds: z.literal(1000),
      minimumWorkerLeaseHeadroomMilliseconds: z.literal(2000),
      deploymentReleaseTag: z.string(),
      deploymentImmutableImageId: z.string(),
      deployedRecoveryGateEnabled: z.literal(true),
      deployedWorkerSampleCount: z.literal(2),
      deployedChainActionCount: z.literal(0),
      deployedQueueRecoveryTransitions: z.literal(0),
      deployedKnownHashReceiptObservations: z.literal(1),
      deployedReceiptTransactionHash: digest,
      transactionBroadcasts: z.literal(0),
      chainWrites: z.literal(0),
    }).passthrough(),
    sources: z.array(z.object({ type: z.string() }).passthrough()),
    limitations: z.array(z.string()),
  }).passthrough().parse(claimInput)
  if (claim.claim !== chainRecoveryRolloutClaimText(summary)) throw new Error("chain recovery rollout claim text does not match evidence")
  const expectedScope = {
    deploymentReleaseTag: summary.releaseTag,
    deploymentImmutableImageId: summary.immutableImageId,
    deployedRecoveryGateEnabled: true,
    deployedWorkerSampleCount: 2,
    deployedChainActionCount: 0,
    deployedQueueRecoveryTransitions: 0,
    deployedKnownHashReceiptObservations: 1,
    deployedReceiptTransactionHash: summary.receiptTransactionHash,
    transactionBroadcasts: 0,
    chainWrites: 0,
  }
  for (const [key, value] of Object.entries(expectedScope)) {
    if ((claim.scope as Record<string, unknown>)[key] !== value) throw new Error(`chain recovery rollout claim scope ${key} does not match evidence`)
  }
  if (JSON.stringify(claim.limitations) !== JSON.stringify(chainRecoveryRolloutLimitations)) throw new Error("chain recovery rollout limitations do not match evidence")
  const deployment = claim.sources.find((source) => source.type === "deployment_evidence")
  const command = claim.sources.find((source) => source.type === "repository_command")
  if (deployment?.path !== "evidence/operations/chain-recovery-rollout-20260909.json") throw new Error("chain recovery claim does not bind rollout evidence")
  if (command?.path !== "scripts/verify-chain-recovery-rollout.ts" || command.command !== "npm run chain-recovery-rollout:verify" || command.observedStatus !== "VERIFIED_DEPLOYED_READ_ONLY_RECOVERY") throw new Error("chain recovery claim does not bind rollout verifier")
  if (!readme.includes(chainRecoveryRolloutReadmeText(summary))) throw new Error("chain recovery README text does not match evidence")
  if (!reproduce.includes(chainRecoveryRolloutReproduceText())) throw new Error("chain recovery reproduction text does not match evidence")
  return summary
}
