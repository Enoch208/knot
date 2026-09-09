import { z } from "zod"
import { address, baseUnits, hexDigest } from "../../contracts/src/primitives.ts"
import { taskSpec, type TaskSpec } from "../../contracts/src/task.ts"
import { AdvantageValidationError, canonicalJson, type EvaluatorMaterials, type ExperimentEvaluator } from "./runner.ts"
import { rawDimensionScore, type RawDimensionScore } from "./schemas.ts"

const utc = z.iso.datetime()
const source = z.object({ uri: z.string().min(1), contentHash: hexDigest, method: z.string().min(1) }).strict()
const market = z
  .object({
    asset: address,
    symbol: z.string().min(1).max(32),
    decimals: z.number().int().min(0).max(36),
    collateralUnits: baseUnits,
    debtUnits: baseUnits,
    oraclePriceUsdE18: baseUnits.nullable(),
    collateralFactorBps: z.number().int().min(0).max(10_000),
    liquidationThresholdBps: z.number().int().min(0).max(10_000),
    collateralEnabled: z.boolean(),
    oracleStatus: z.enum(["current", "unavailable"]),
    priceObservedAtUtc: utc.nullable(),
    supported: z.boolean(),
  })
  .strict()

const snapshot = z
  .object({
    schemaVersion: z.literal("knot.health.snapshot/1"),
    snapshotId: z.string().min(1),
    chainId: z.literal(56),
    blockNumber: baseUnits,
    blockHash: hexDigest,
    blockTimestampUtc: utc,
    capturedAtUtc: utc,
    canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
    sources: z.array(source).min(1),
    borrower: address,
    comptroller: address,
    poolFamily: z.enum(["venus-core", "venus-isolated"]),
    debtInventoryComplete: z.boolean(),
    protocolStatus: z.enum(["active", "paused", "unknown"]),
    forcedLiquidation: z.enum(["enabled", "paused", "unknown"]),
    actionAvailable: z.boolean(),
    markets: z.array(market),
    specialDebts: z.array(z.object({ kind: z.string().min(1), valueUsdE18: baseUnits.nullable(), supported: z.boolean() }).strict()),
  })
  .strict()

type HealthTaskSpec = Extract<TaskSpec, { category: "health" }>
const healthTaskSpec = taskSpec.refine((task) => task.category === "health").transform((task) => task as HealthTaskSpec)

export const healthGuardEvaluationInput = z
  .object({
    schemaVersion: z.literal("knot.health.request/1"),
    task: healthTaskSpec,
    snapshot,
    maxSnapshotAgeSeconds: z.number().int().positive().max(300),
  })
  .strict()

const artifactPosition = z
  .object({
    asset: address,
    symbol: z.string().min(1).max(32),
    collateralUnits: baseUnits,
    debtUnits: baseUnits,
    oraclePriceUsdE18: baseUnits.nullable(),
    collateralValueUsdE18: baseUnits.nullable(),
    debtValueUsdE18: baseUnits.nullable(),
    collateralFactorBps: z.number().int().min(0).max(10_000),
    liquidationThresholdBps: z.number().int().min(0).max(10_000),
    collateralEnabled: z.boolean(),
    priceObservedAtUtc: utc.nullable(),
  })
  .strict()

const metrics = z
  .object({
    collateralValueUsdE18: baseUnits.nullable(),
    borrowingPowerCollateralUsdE18: baseUnits.nullable(),
    liquidationThresholdCollateralUsdE18: baseUnits.nullable(),
    debtValueUsdE18: baseUnits.nullable(),
    healthRatioE18: baseUnits.nullable(),
  })
  .strict()

export const healthGuardEvaluationArtifact = z
  .object({
    schemaVersion: z.literal("knot.health.artifact/1"),
    category: z.literal("health"),
    capability: z.literal("analysis"),
    taskId: z.string().min(1).nullable(),
    status: z.enum(["ASSESSED", "NO_DEBT", "ASSESSMENT_INCOMPLETE", "STALE_SNAPSHOT", "UNSUPPORTED_POSITION", "INVALID_REQUEST"]),
    reasonCode: z.enum(["INVALID_JSON", "SCHEMA_VALIDATION_FAILED", "UNSUPPORTED_POOL_FAMILY", "CAPABILITY_NOT_SUPPORTED", "SNAPSHOT_TARGET_MISMATCH", "STALE_SNAPSHOT", "RESULT_INCOMPLETE", "NO_DEBT"]).nullable(),
    assessedAtUtc: utc,
    snapshot: z.object({ snapshotId: z.string().min(1), chainId: z.literal(56), blockNumber: baseUnits, blockHash: hexDigest }).strict().nullable(),
    protocol: z.object({ family: z.enum(["venus-core", "venus-isolated"]), comptroller: address, status: z.enum(["active", "paused", "unknown"]), forcedLiquidation: z.enum(["enabled", "paused", "unknown"]) }).strict().nullable(),
    positions: z.array(artifactPosition),
    metrics,
    missingCoverage: z.array(z.string().min(1)),
    recommendation: z.enum(["HOLD", "REPAY", "NONE", "REFUSED"]),
    minimumEligibleAction: z.object({ available: z.boolean(), reason: z.string().min(1).nullable(), asset: address, requiredUnits: baseUnits.nullable(), withinMaximum: z.boolean() }).strict().nullable(),
    projectedPostAction: z.object({ debtValueUsdE18: baseUnits, healthRatioE18: baseUnits.nullable() }).strict().nullable(),
    assumptions: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
  })
  .strict()

interface ExpectedAssessment {
  status: "ASSESSED" | "NO_DEBT" | "ASSESSMENT_INCOMPLETE" | "STALE_SNAPSHOT" | "UNSUPPORTED_POSITION"
  metrics: z.infer<typeof metrics>
  recommendation: "HOLD" | "REPAY" | "NONE" | "REFUSED"
  requiredRepaymentUnits: string | null
}

export class HealthGuardIndependentEvaluator implements ExperimentEvaluator {
  readonly id = "healthguard-independent"
  readonly version = "1.0.0"

  evaluate(materials: EvaluatorMaterials): RawDimensionScore[] {
    const input = parseJson(materials.input)
    const parsedInput = healthGuardEvaluationInput.parse(input)
    if (canonicalJson(parsedInput.task) !== canonicalJson(materials.task)) {
      throw new AdvantageValidationError("INPUT_MISMATCH", "HealthGuard input task does not match the experiment task")
    }
    const scores = [
      scoreCandidate(materials.agent.artifact, parsedInput, materials.agent.observation),
      scoreCandidate(materials.baseline.artifact, parsedInput, materials.baseline.observation),
    ] as const
    return [
      dimension("contract_integrity", "Closed artifact and input identity", scores, "contract"),
      dimension("risk_classification", "Risk-state classification", scores, "classification"),
      dimension("deterministic_math", "Collateral, debt, threshold, and health math", scores, "math"),
      dimension("bounded_recommendation", "Recommendation and bounded repayment", scores, "recommendation"),
    ].map((value) => rawDimensionScore.parse(value))
  }
}

type ScoreKey = "contract" | "classification" | "math" | "recommendation"
type CandidateScores = Record<ScoreKey, { scoreBps: number; rationale: string }>

function dimension(id: string, label: string, scores: readonly [CandidateScores, CandidateScores], key: ScoreKey): RawDimensionScore {
  return { id, label, toleranceBps: 0, agent: scores[0][key], baseline: scores[1][key] }
}

function scoreCandidate(
  bytes: Uint8Array,
  input: z.infer<typeof healthGuardEvaluationInput>,
  observation: EvaluatorMaterials["agent"]["observation"],
): CandidateScores {
  let decoded: unknown
  try {
    decoded = parseJson(bytes)
  } catch {
    return failedScores("artifact is not valid JSON")
  }
  const parsed = healthGuardEvaluationArtifact.safeParse(decoded)
  if (!parsed.success) return failedScores("artifact does not satisfy the closed HealthGuard output contract")
  const artifact = parsed.data
  const assessedAt = Date.parse(artifact.assessedAtUtc)
  const withinObservation = assessedAt >= Date.parse(observation.startedAtUtc) && assessedAt <= Date.parse(observation.endedAtUtc)
  const identityMatches = artifact.taskId === input.task.taskId && artifact.snapshot?.snapshotId === input.snapshot.snapshotId && artifact.snapshot?.blockHash === input.snapshot.blockHash
  const expected = expectedAssessment(input, new Date(observation.endedAtUtc))
  const contractPassed = withinObservation && identityMatches
  const classificationPassed = artifact.status === expected.status
  const mathPassed = canonicalJson(artifact.metrics) === canonicalJson(expected.metrics)
  const recommendationPassed = artifact.recommendation === expected.recommendation && (artifact.minimumEligibleAction?.requiredUnits ?? null) === expected.requiredRepaymentUnits
  return {
    contract: binary(contractPassed, "artifact identity and observation time match", "artifact identity or observation time does not match"),
    classification: binary(classificationPassed, "status matches independent classification", "status differs from independent classification"),
    math: binary(mathPassed, "reported metrics match independent integer arithmetic", "reported metrics differ from independent integer arithmetic"),
    recommendation: binary(recommendationPassed, "recommendation and repayment bound match", "recommendation or repayment bound differs"),
  }
}

function expectedAssessment(input: z.infer<typeof healthGuardEvaluationInput>, now: Date): ExpectedAssessment {
  const emptyMetrics = { collateralValueUsdE18: null, borrowingPowerCollateralUsdE18: null, liquidationThresholdCollateralUsdE18: null, debtValueUsdE18: null, healthRatioE18: null }
  if (input.task.capability !== "analysis" || input.task.constraints.mode !== "notify" || input.snapshot.poolFamily !== "venus-core") {
    return { status: "UNSUPPORTED_POSITION", metrics: emptyMetrics, recommendation: "REFUSED", requiredRepaymentUnits: null }
  }
  const targetMismatch = input.task.snapshotId !== input.snapshot.snapshotId || input.task.dataChainId !== input.snapshot.chainId || input.task.target.borrower !== input.snapshot.borrower || input.task.target.comptroller !== input.snapshot.comptroller || input.task.target.poolFamily !== input.snapshot.poolFamily
  if (targetMismatch) return { status: "ASSESSMENT_INCOMPLETE", metrics: emptyMetrics, recommendation: "REFUSED", requiredRepaymentUnits: null }
  const maximumAge = input.maxSnapshotAgeSeconds * 1_000
  const stale = input.snapshot.canonicality !== "confirmed" || Math.abs(now.getTime() - Date.parse(input.snapshot.capturedAtUtc)) > maximumAge || input.snapshot.markets.some((item) => item.priceObservedAtUtc !== null && Math.abs(now.getTime() - Date.parse(item.priceObservedAtUtc)) > maximumAge)
  if (stale) return { status: "STALE_SNAPSHOT", metrics: emptyMetrics, recommendation: "REFUSED", requiredRepaymentUnits: null }
  const incomplete = !input.snapshot.debtInventoryComplete || input.snapshot.protocolStatus === "unknown" || input.snapshot.forcedLiquidation === "unknown" || input.snapshot.markets.some((item) => !item.supported || item.oracleStatus !== "current" || item.oraclePriceUsdE18 === null || item.oraclePriceUsdE18 === "0" || item.priceObservedAtUtc === null) || input.snapshot.specialDebts.some((item) => !item.supported || item.valueUsdE18 === null)
  if (incomplete) return { status: "ASSESSMENT_INCOMPLETE", metrics: emptyMetrics, recommendation: "REFUSED", requiredRepaymentUnits: null }
  const totals = calculateTotals(input.snapshot)
  const calculated = {
    collateralValueUsdE18: totals.collateral.toString(),
    borrowingPowerCollateralUsdE18: totals.borrowingPower.toString(),
    liquidationThresholdCollateralUsdE18: totals.threshold.toString(),
    debtValueUsdE18: totals.debt.toString(),
    healthRatioE18: totals.debt === 0n ? null : ((totals.threshold * 10n ** 18n) / totals.debt).toString(),
  }
  if (totals.debt === 0n) return { status: "NO_DEBT", metrics: calculated, recommendation: "NONE", requiredRepaymentUnits: null }
  const actionThreshold = decimalFraction(input.task.constraints.actionThresholdRatio)
  const needsRepayment = totals.threshold * actionThreshold.denominator < totals.debt * actionThreshold.numerator
  return {
    status: "ASSESSED",
    metrics: calculated,
    recommendation: needsRepayment ? "REPAY" : "HOLD",
    requiredRepaymentUnits: needsRepayment ? repaymentUnits(input, totals.threshold, totals.debt) : null,
  }
}

function calculateTotals(value: z.infer<typeof snapshot>) {
  let collateral = 0n
  let borrowingPower = 0n
  let threshold = 0n
  let debt = 0n
  for (const item of value.markets) {
    const price = BigInt(item.oraclePriceUsdE18 as string)
    const scale = 10n ** BigInt(item.decimals)
    const collateralValue = (BigInt(item.collateralUnits) * price) / scale
    const debtNumerator = BigInt(item.debtUnits) * price
    const debtValue = debtNumerator === 0n ? 0n : (debtNumerator + scale - 1n) / scale
    collateral += collateralValue
    debt += debtValue
    if (item.collateralEnabled) {
      borrowingPower += (collateralValue * BigInt(item.collateralFactorBps)) / 10_000n
      threshold += (collateralValue * BigInt(item.liquidationThresholdBps)) / 10_000n
    }
  }
  for (const special of value.specialDebts) debt += BigInt(special.valueUsdE18 as string)
  return { collateral, borrowingPower, threshold, debt }
}

function repaymentUnits(input: z.infer<typeof healthGuardEvaluationInput>, threshold: bigint, debt: bigint): string | null {
  const target = decimalFraction(input.task.constraints.safetyThresholdRatio)
  const targetDebt = (threshold * target.denominator) / target.numerator
  const requiredValue = debt > targetDebt ? debt - targetDebt : 0n
  const asset = input.snapshot.markets.find((item) => item.asset === input.task.constraints.repaymentAsset)
  if (!asset || asset.oraclePriceUsdE18 === null) return null
  const numerator = requiredValue * 10n ** BigInt(asset.decimals)
  const denominator = BigInt(asset.oraclePriceUsdE18)
  return (numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator).toString()
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [whole, fraction = ""] = value.toString().split(".")
  return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) }
}

function failedScores(rationale: string): CandidateScores {
  const score = { scoreBps: 0, rationale }
  return { contract: score, classification: score, math: score, recommendation: score }
}

function binary(passed: boolean, success: string, failure: string): { scoreBps: number; rationale: string } {
  return { scoreBps: passed ? 10_000 : 0, rationale: passed ? success : failure }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
