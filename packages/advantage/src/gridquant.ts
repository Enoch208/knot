import { z } from "zod"
import { keccak256, toHex } from "viem"
import type { TaskSpec } from "../../contracts/src/task.ts"
import { AdvantageValidationError, canonicalJson, type EvaluatorMaterials, type ExperimentEvaluator } from "./runner.ts"
import { rawDimensionScore, type RawDimensionScore } from "./schemas.ts"
import { deriveGridQuantExpected, type GridQuantExpected } from "./gridquant-reference.ts"
import { gridQuantEvaluationArtifact, gridQuantEvaluationInput, type GridQuantEvaluationArtifact, type GridQuantEvaluationInput } from "./gridquant-schemas.ts"

const manifest = z
  .object({
    version: z.literal(1),
    chain_id: z.literal(97),
    job_id: z.number().int().nonnegative(),
    contracts: z.object({ commerce: z.string().regex(/^0x[0-9a-fA-F]{40}$/), policy: z.string().regex(/^0x[0-9a-fA-F]{40}$/), router: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).strict(),
    metadata: z.object({ built_with: z.literal("https://github.com/bnb-chain/bnbagent-studio"), generator: z.string().min(1), job_id: z.number().int().nonnegative() }).strict(),
    response: z.object({ content: z.string().min(1), content_type: z.literal("text/plain") }).strict(),
  })
  .strict()
type GridTask = Extract<TaskSpec, { category: "grid" }>
type ScoreKey = "contract" | "levels" | "allocation" | "fees" | "decision"
type CandidateScores = Record<ScoreKey, { scoreBps: number; rationale: string }>

export class GridQuantIndependentEvaluator implements ExperimentEvaluator {
  readonly id = "gridquant-independent"
  readonly version = "1.0.0"

  evaluate(materials: EvaluatorMaterials): RawDimensionScore[] {
    const input = parseInput(materials.input)
    const task = gridTask(materials.task)
    assertGridTaskBinding(task, input, materials.input)
    const scores = [
      scoreCandidate(materials.agent.artifact, input, materials.agent.observation, materials.agent.rawOutput),
      scoreCandidate(materials.baseline.artifact, input, materials.baseline.observation),
    ] as const
    return [
      dimension("contract_integrity", "Closed task, manifest, artifact, snapshot, and source binding", scores, "contract"),
      dimension("grid_level_math", "Independent arithmetic or geometric level construction", scores, "levels"),
      dimension("allocation_and_inventory", "Capital allocation, base rounding, and inventory bounds", scores, "allocation"),
      dimension("fee_and_spread_feasibility", "Pinned gas, fee, slippage, and adjacent-spread checks", scores, "fees"),
      dimension("bounded_decision", "Plan, no-action, or refusal outcome", scores, "decision"),
    ].map((value) => rawDimensionScore.parse(value))
  }
}

function scoreCandidate(bytes: Uint8Array, input: GridQuantEvaluationInput, observation: EvaluatorMaterials["agent"]["observation"], rawManifest?: Uint8Array): CandidateScores {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return failed("artifact is not valid JSON")
  }
  const parsed = gridQuantEvaluationArtifact.safeParse(decoded)
  if (!parsed.success) return failed("artifact does not satisfy the closed GridQuant contract")
  const artifact = parsed.data
  const assessedAt = Date.parse(artifact.assessedAtUtc)
  const withinObservation = assessedAt >= Date.parse(observation.startedAtUtc) && assessedAt <= Date.parse(observation.endedAtUtc)
  const expected = deriveGridQuantExpected(input, new Date(artifact.assessedAtUtc))
  const manifestMatches = rawManifest === undefined || manifestBindsArtifact(rawManifest, artifact)
  const contractMatches = manifestMatches && artifact.taskId === input.task.taskId && canonicalJson(artifact.evidence) === canonicalJson(expected.evidence) && canonicalJson(artifact.timing) === canonicalJson(expected.timing) && canonicalJson(artifact.fillPolicy) === canonicalJson(expected.fillPolicy) && canonicalJson(artifact.performance) === canonicalJson(expected.performance) && canonicalJson(artifact.limitations) === canonicalJson(expected.limitations) && artifact.historicalEvaluation === null && withinObservation
  return {
    contract: binary(contractMatches, "manifest content, artifact identity, sources, and observation time match", "manifest, artifact identity, sources, or observation time differs"),
    levels: binary(levelView(artifact) === levelView(expected), "grid levels match independent integer construction", "grid spacing, indexes, or price levels differ"),
    allocation: binary(allocationView(artifact) === allocationView(expected), "allocation, rounding, capital, and inventory reconcile", "allocation, rounding, capital, or inventory differs"),
    fees: binary(feeView(artifact) === feeView(expected), "gas, fees, slippage, and break-even spread reconcile", "gas, fees, slippage, or break-even spread differs"),
    decision: binary(decisionView(artifact) === decisionView(expected), "plan, no-action, or refusal matches", "status, reason, result, or bounded checks differ"),
  }
}

function manifestBindsArtifact(bytes: Uint8Array, artifact: GridQuantEvaluationArtifact): boolean {
  try {
    const parsed = manifest.safeParse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
    if (!parsed.success || parsed.data.job_id !== parsed.data.metadata.job_id) return false
    return canonicalJson(JSON.parse(parsed.data.response.content) as unknown) === canonicalJson(artifact)
  } catch {
    return false
  }
}

function assertGridTaskBinding(task: GridTask, input: GridQuantEvaluationInput, bytes: Uint8Array): void {
  const internal = input.task
  const parameters = internal.parameters
  const expected = {
    taskId: internal.taskId,
    capability: internal.capability,
    identityChainId: internal.identityChainId,
    dataChainId: internal.dataChainId,
    paymentChainId: internal.paymentChainId,
    executionChainId: internal.executionChainId,
    snapshotId: internal.snapshotId,
    inputHash: keccak256(toHex(bytes)),
    target: { baseToken: internal.pair.baseToken.address, quoteToken: internal.pair.quoteToken.address, pool: internal.pair.pool },
    constraints: { lowerPriceUnits: parameters.lowerPriceUnits, upperPriceUnits: parameters.upperPriceUnits, gridCount: parameters.gridCount, spacing: parameters.spacing, principalUnits: parameters.principalQuoteUnits, orderSizeFloorUnits: parameters.orderSizeFloorQuoteUnits, maxInventoryExposureUnits: parameters.maxBaseInventoryUnits, slippageBps: parameters.slippageBps, cooldownSeconds: parameters.cooldownSeconds, expiryUtc: parameters.expiryUtc, mode: parameters.executionMode === "analysis" ? "analysis" : "execute" },
  }
  const actual = { taskId: task.taskId, capability: task.capability, identityChainId: task.identityChainId, dataChainId: task.dataChainId, paymentChainId: task.paymentChainId, executionChainId: task.executionChainId, snapshotId: task.snapshotId, inputHash: task.inputHash, target: task.target, constraints: task.constraints }
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new AdvantageValidationError("INPUT_MISMATCH", "GridQuant marketplace task or cryptographic request binding does not match")
}

function gridTask(task: TaskSpec): GridTask {
  if (task.category !== "grid") throw new AdvantageValidationError("INPUT_MISMATCH", "GridQuant evaluator requires a grid task")
  return task
}

function parseInput(bytes: Uint8Array): GridQuantEvaluationInput {
  try {
    return gridQuantEvaluationInput.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } catch {
    throw new AdvantageValidationError("INPUT_MISMATCH", "GridQuant evidence does not contain a valid closed request")
  }
}

function levelView(value: GridQuantEvaluationArtifact | GridQuantExpected): string {
  return canonicalJson(value.result?.outcome === "PLAN" ? { spacing: value.result.spacing, pairId: value.result.pairId, levels: value.result.levels.map((level) => ({ index: level.index, priceUnits: level.priceUnits, priceDecimals: level.priceDecimals })) } : null)
}

function allocationView(value: GridQuantEvaluationArtifact | GridQuantExpected): string {
  return canonicalJson(value.result?.outcome === "PLAN" ? { levels: value.result.levels.map((level) => ({ index: level.index, allocatedQuoteUnits: level.allocatedQuoteUnits, estimatedBaseUnits: level.estimatedBaseUnits, amountRounding: level.amountRounding })), capital: value.result.capital } : null)
}

function feeView(value: GridQuantEvaluationArtifact | GridQuantExpected): string {
  return canonicalJson(value.result?.outcome === "PLAN" ? value.result.fees : null)
}

function decisionView(value: GridQuantEvaluationArtifact | GridQuantExpected): string {
  return canonicalJson({ status: value.status, reasonCode: value.reasonCode, outcome: value.result?.outcome ?? null, noAction: value.result?.outcome === "NO_ACTION" ? value.result : null, parameterChecks: value.result?.outcome === "PLAN" ? value.result.parameterChecks : null })
}

function dimension(id: string, label: string, scores: readonly [CandidateScores, CandidateScores], key: ScoreKey): RawDimensionScore {
  return { id, label, toleranceBps: 0, agent: scores[0][key], baseline: scores[1][key] }
}

function failed(rationale: string): CandidateScores {
  const score = { scoreBps: 0, rationale }
  return { contract: score, levels: score, allocation: score, fees: score, decision: score }
}

function binary(value: boolean, success: string, failure: string): { scoreBps: number; rationale: string } {
  return { scoreBps: value ? 10_000 : 0, rationale: value ? success : failure }
}
