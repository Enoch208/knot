import { keccak256, toHex } from "viem"
import type { TaskSpec } from "../../contracts/src/task.ts"
import { AdvantageValidationError, canonicalJson, type EvaluatorMaterials, type ExperimentEvaluator } from "./runner.ts"
import { rawDimensionScore, type RawDimensionScore } from "./schemas.ts"
import { deriveYieldExpected, type YieldExpectedResult } from "./yieldscout-reference.ts"
import { yieldScoutEvaluationArtifact, yieldScoutEvaluationInput, type YieldComparison, type YieldScoutEvaluationInput } from "./yieldscout-schemas.ts"

type YieldTask = Extract<TaskSpec, { category: "yield" }>
type ScoreKey = "contract" | "rate" | "cost" | "exclusions" | "selection"
type CandidateScores = Record<ScoreKey, { scoreBps: number; rationale: string }>

export class YieldScoutIndependentEvaluator implements ExperimentEvaluator {
  readonly id = "yieldscout-independent"
  readonly version = "1.0.0"

  evaluate(materials: EvaluatorMaterials): RawDimensionScore[] {
    const input = parseInput(materials.input)
    const task = yieldTask(materials.task)
    assertTaskBinding(task, input, materials.input)
    const scores = [
      scoreCandidate(materials.agent.artifact, input, materials.agent.observation),
      scoreCandidate(materials.baseline.artifact, input, materials.baseline.observation),
    ] as const
    return [
      dimension("contract_integrity", "Closed artifact, task, snapshot, and source binding", scores, "contract"),
      dimension("rate_and_horizon_math", "Independent rate normalization and horizon benefit", scores, "rate"),
      dimension("disclosed_cost_math", "Disclosed route costs, net benefit, and hold improvement", scores, "cost"),
      dimension("market_exclusions", "Liquidity, capacity, concentration, protocol, and risk exclusions", scores, "exclusions"),
      dimension("bounded_selection", "Selected migration or hold decision", scores, "selection"),
    ].map((value) => rawDimensionScore.parse(value))
  }
}

function scoreCandidate(bytes: Uint8Array, input: YieldScoutEvaluationInput, observation: EvaluatorMaterials["agent"]["observation"]): CandidateScores {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return failed("artifact is not valid JSON")
  }
  const parsed = yieldScoutEvaluationArtifact.safeParse(decoded)
  if (!parsed.success) return failed("artifact does not satisfy the closed YieldScout contract")
  const artifact = parsed.data
  const expected = deriveYieldExpected(input, new Date(observation.endedAtUtc))
  const assessedAt = Date.parse(artifact.assessedAtUtc)
  const withinObservation = assessedAt >= Date.parse(observation.startedAtUtc) && assessedAt <= Date.parse(observation.endedAtUtc)
  const contractMatches = artifact.taskId === input.taskId && artifact.currentMarketId === input.currentMarketId && canonicalJson(artifact.evidence) === canonicalJson(expectedEvidence(input)) && withinObservation
  return {
    contract: binary(contractMatches, "artifact identity, source URIs, and observation time match", "artifact identity, source URIs, or observation time differs"),
    rate: binary(rateRows(artifact.eligibleMarkets) === rateRows(expected.eligibleMarkets), "annual rates and horizon benefits match independent integer arithmetic", "annual rates or horizon benefits differ from independent arithmetic"),
    cost: binary(costRows(artifact.eligibleMarkets) === costRows(expected.eligibleMarkets), "disclosed costs and net benefits reconcile", "disclosed costs, net benefits, or hold improvements do not reconcile"),
    exclusions: binary(canonicalJson(artifact.excludedMarkets) === canonicalJson(expected.excludedMarkets), "market exclusions match independently derived safety gates", "market exclusions omit or alter independently derived safety gates"),
    selection: binary(selection(artifact) === selection(expected), "recommendation and selected market match the independent decision", "recommendation or selected market differs from the independent decision"),
  }
}

function assertTaskBinding(task: YieldTask, input: YieldScoutEvaluationInput, bytes: Uint8Array): void {
  const minimumImprovement = ceilDiv(BigInt(input.amountUnits) * BigInt(task.constraints.minImprovementBps), 10_000n).toString()
  const expected = {
    taskId: input.taskId,
    capability: input.capability,
    identityChainId: input.identityChainId,
    dataChainId: input.dataChainId,
    paymentChainId: input.paymentChainId,
    executionChainId: input.executionChainId,
    snapshotId: input.snapshot.snapshotId,
    inputHash: keccak256(toHex(bytes)),
    asset: input.asset.address,
    amountUnits: input.amountUnits,
    horizonSeconds: input.holdingHorizonSeconds,
    allowedProtocols: [...input.allowedProtocols].sort(),
    allowLpExposure: !input.noLpExposure,
    minMarketLiquidityUnits: input.minimumLiquidityUnits,
    concentrationCapBps: input.concentrationCapBps,
    gasAllowanceWei: input.gasAllowanceUnits,
    minimumImprovementUnits: input.minimumImprovementUnits,
    mode: input.capability === "analysis" ? "analysis" : "execute",
  }
  const actual = {
    taskId: task.taskId,
    capability: task.capability,
    identityChainId: task.identityChainId,
    dataChainId: task.dataChainId,
    paymentChainId: task.paymentChainId,
    executionChainId: task.executionChainId,
    snapshotId: task.snapshotId,
    inputHash: task.inputHash,
    asset: task.target.asset,
    amountUnits: task.target.amountUnits,
    horizonSeconds: task.constraints.horizonSeconds,
    allowedProtocols: [...task.constraints.allowedProtocols].sort(),
    allowLpExposure: task.constraints.allowLpExposure,
    minMarketLiquidityUnits: task.constraints.minMarketLiquidityUnits,
    concentrationCapBps: task.constraints.concentrationCapBps,
    gasAllowanceWei: task.constraints.gasAllowanceWei,
    minimumImprovementUnits: minimumImprovement,
    mode: task.constraints.mode,
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new AdvantageValidationError("INPUT_MISMATCH", "YieldScout task fields or cryptographic input binding do not match the raw request")
}

function yieldTask(task: TaskSpec): YieldTask {
  if (task.category !== "yield") throw new AdvantageValidationError("INPUT_MISMATCH", "YieldScout evaluator requires a yield task")
  return task
}

function parseInput(bytes: Uint8Array): YieldScoutEvaluationInput {
  try {
    return yieldScoutEvaluationInput.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } catch {
    throw new AdvantageValidationError("INPUT_MISMATCH", "YieldScout evidence does not contain a valid closed request")
  }
}

function expectedEvidence(input: YieldScoutEvaluationInput) {
  return {
    snapshotId: input.snapshot.snapshotId,
    chainId: input.snapshot.chainId,
    blockNumber: input.snapshot.blockNumber,
    blockHash: input.snapshot.blockHash,
    blockTimestampUtc: input.snapshot.blockTimestampUtc,
    capturedAtUtc: input.snapshot.capturedAtUtc,
    sources: input.snapshot.sources.map((source) => source.uri),
  }
}

function rateRows(rows: YieldComparison[]): string {
  return canonicalJson(rows.map((row) => ({ marketId: row.marketId, protocol: row.protocol, integrationId: row.integrationId, rateBasis: row.rateBasis, baseRateSourceUri: row.baseRateSourceUri, baseAnnualRateRay: row.baseAnnualRateRay, incentiveStatus: row.incentiveStatus, incentiveValuationSourceUri: row.incentiveValuationSourceUri, incentiveAnnualRateRay: row.incentiveAnnualRateRay, horizonBaseBenefitUnits: row.horizonBaseBenefitUnits, horizonIncentiveBenefitUnits: row.horizonIncentiveBenefitUnits })))
}

function costRows(rows: YieldComparison[]): string {
  return canonicalJson(rows.map((row) => ({ marketId: row.marketId, entryCostUnits: row.entryCostUnits, exitCostUnits: row.exitCostUnits, sourceExitCostUnits: row.sourceExitCostUnits, netBenefitUnits: row.netBenefitUnits, improvementVsHoldUnits: row.improvementVsHoldUnits })))
}

function selection(value: { status: string; reasonCode: string | null; recommendation: string; selectedMarketId: string | null }): string {
  return canonicalJson({ status: value.status, reasonCode: value.reasonCode, recommendation: value.recommendation, selectedMarketId: value.selectedMarketId })
}

function dimension(id: string, label: string, scores: readonly [CandidateScores, CandidateScores], key: ScoreKey): RawDimensionScore {
  return { id, label, toleranceBps: 0, agent: scores[0][key], baseline: scores[1][key] }
}

function failed(rationale: string): CandidateScores {
  const score = { scoreBps: 0, rationale }
  return { contract: score, rate: score, cost: score, exclusions: score, selection: score }
}

function binary(value: boolean, success: string, failure: string): { scoreBps: number; rationale: string } {
  return { scoreBps: value ? 10_000 : 0, rationale: value ? success : failure }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator
}
