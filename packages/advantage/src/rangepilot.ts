import { keccak256, toHex } from "viem"
import type { TaskSpec } from "../../contracts/src/task.ts"
import { AdvantageValidationError, canonicalJson, type EvaluatorMaterials, type ExperimentEvaluator } from "./runner.ts"
import { rawDimensionScore, type RawDimensionScore } from "./schemas.ts"
import { deriveRangePilotExpected, type RangePilotExpected } from "./rangepilot-reference.ts"
import { rangePilotEvaluationArtifact, rangePilotEvaluationInput, type RangePilotEvaluationArtifact, type RangePilotEvaluationInput } from "./rangepilot-schemas.ts"

type RebalancingTask = Extract<TaskSpec, { category: "rebalancing" }>
type ScoreKey = "contract" | "position" | "ticks" | "amounts" | "constraints" | "decision"
type CandidateScores = Record<ScoreKey, { scoreBps: number; rationale: string }>

export class RangePilotIndependentEvaluator implements ExperimentEvaluator {
  readonly id = "rangepilot-independent"
  readonly version = "1.0.0"

  evaluate(materials: EvaluatorMaterials): RawDimensionScore[] {
    const input = parseInput(materials.input)
    const task = rebalancingTask(materials.task)
    assertRangeTaskBinding(task, input, materials.input)
    const scores = [
      scoreCandidate(materials.agent.artifact, input, materials.agent.observation),
      scoreCandidate(materials.baseline.artifact, input, materials.baseline.observation),
    ] as const
    return [
      dimension("contract_integrity", "Closed artifact, task, snapshot, and source binding", scores, "contract"),
      dimension("position_classification", "Independent in-range or out-of-range classification", scores, "position"),
      dimension("tick_range_feasibility", "Aligned bounded range derivation", scores, "ticks"),
      dimension("amount_and_budget_math", "Conservative token rounding, availability, and budgets", scores, "amounts"),
      dimension("constraint_refusals", "Gas, slippage, cooldown, and feasibility gates", scores, "constraints"),
      dimension("bounded_decision", "Hold, proposal, or refusal outcome", scores, "decision"),
    ].map((value) => rawDimensionScore.parse(value))
  }
}

function scoreCandidate(bytes: Uint8Array, input: RangePilotEvaluationInput, observation: EvaluatorMaterials["agent"]["observation"]): CandidateScores {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return failed("artifact is not valid JSON")
  }
  const parsed = rangePilotEvaluationArtifact.safeParse(decoded)
  if (!parsed.success) return failed("artifact does not satisfy the closed RangePilot contract")
  const artifact = parsed.data
  const assessedAt = Date.parse(artifact.assessedAtUtc)
  const withinObservation = assessedAt >= Date.parse(observation.startedAtUtc) && assessedAt <= Date.parse(observation.endedAtUtc)
  const expectedAtAssessment = deriveRangePilotExpected(input, new Date(artifact.assessedAtUtc))
  const contractMatches = artifact.taskId === input.task.taskId && canonicalJson(artifact.evidence) === canonicalJson(expectedAtAssessment.evidence) && canonicalJson(artifact.assumptions) === canonicalJson(expectedAtAssessment.assumptions) && canonicalJson(artifact.unavailableMetrics) === canonicalJson(expectedAtAssessment.unavailableMetrics) && withinObservation
  return {
    contract: binary(contractMatches, "artifact identity, provenance, limitations, and observation time match", "artifact identity, provenance, limitations, or observation time differs"),
    position: binary(positionView(artifact) === positionView(expectedAtAssessment), "position state and range condition match independent derivation", "position state or range condition differs"),
    ticks: binary(tickView(artifact) === tickView(expectedAtAssessment), "ticks are independently aligned and bounded", "tick bounds, alignment, width, or liquidity differs"),
    amounts: binary(amountView(artifact) === amountView(expectedAtAssessment), "token amounts use conservative rounding and reconcile to budgets", "token rounding, availability, or budget checks differ"),
    constraints: binary(constraintView(artifact) === constraintView(expectedAtAssessment), "feasibility and refusal gates match", "gas, slippage, cooldown, or feasibility gates differ"),
    decision: binary(decisionView(artifact) === decisionView(expectedAtAssessment), "hold, proposal, or refusal matches the independent result", "status, reason, or decision differs"),
  }
}

function assertRangeTaskBinding(task: RebalancingTask, input: RangePilotEvaluationInput, bytes: Uint8Array): void {
  const internal = input.task
  if (internal.constraints.token0BudgetUnits !== internal.constraints.token1BudgetUnits) {
    throw new AdvantageValidationError("INPUT_MISMATCH", "the shared task cannot bind unequal per-token RangePilot budgets")
  }
  const expected = {
    taskId: internal.taskId,
    capability: internal.capability,
    identityChainId: 97,
    dataChainId: internal.chainId,
    paymentChainId: 97,
    executionChainId: null,
    snapshotId: internal.snapshotId,
    inputHash: keccak256(toHex(bytes)),
    positionManager: internal.positionManager,
    positionTokenId: internal.positionTokenId,
    controllingAccount: internal.controllingAccount,
    pool: internal.allowedPool.address,
    tokenBudgetUnits: internal.constraints.token0BudgetUnits,
    rangeWidthBps: internal.constraints.targetRangeWidthTicks,
    slippageBps: internal.constraints.maximumSlippageBps,
    cooldownSeconds: internal.constraints.cooldownSeconds,
    mode: internal.constraints.executionMode === "analysis" ? "analysis" : "execute",
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
    positionManager: task.target.positionManager,
    positionTokenId: task.target.positionTokenId,
    controllingAccount: task.target.controllingAccount,
    pool: task.target.pool,
    tokenBudgetUnits: task.constraints.tokenBudgetUnits,
    rangeWidthBps: task.constraints.rangeWidthBps,
    slippageBps: task.constraints.slippageBps,
    cooldownSeconds: task.constraints.cooldownSeconds,
    mode: task.constraints.mode,
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new AdvantageValidationError("INPUT_MISMATCH", "RangePilot task fields or cryptographic request binding do not match")
}

function rebalancingTask(task: TaskSpec): RebalancingTask {
  if (task.category !== "rebalancing") throw new AdvantageValidationError("INPUT_MISMATCH", "RangePilot evaluator requires a rebalancing task")
  return task
}

function parseInput(bytes: Uint8Array): RangePilotEvaluationInput {
  try {
    return rangePilotEvaluationInput.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } catch {
    throw new AdvantageValidationError("INPUT_MISMATCH", "RangePilot evidence does not contain a valid closed request")
  }
}

function positionView(value: RangePilotEvaluationArtifact | RangePilotExpected): string {
  const state = value.currentState
  if (state === null) return "null"
  return canonicalJson({ owner: state.owner, pool: state.pool, token0: state.token0, token1: state.token1, currentTick: state.currentTick, tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing: state.tickSpacing, liquidity: state.liquidity, activeLiquidity: state.activeLiquidity, tokensOwed0: state.tokensOwed0, tokensOwed1: state.tokensOwed1, condition: state.condition })
}

function tickView(value: RangePilotEvaluationArtifact | RangePilotExpected): string {
  const proposal = value.proposal
  if (proposal === null) return "null"
  return canonicalJson({ tickLower: proposal.tickLower, tickUpper: proposal.tickUpper, widthTicks: proposal.widthTicks, liquidity: proposal.liquidity, check: proposal.checks.find((item) => item.code === "TICK_BOUNDS") ?? null })
}

function amountView(value: RangePilotEvaluationArtifact | RangePilotExpected): string {
  const codes = new Set(["TOKEN0_AVAILABLE", "TOKEN0_BUDGET", "TOKEN1_AVAILABLE", "TOKEN1_BUDGET"])
  return canonicalJson({
    current: value.currentState === null ? null : { amount0Units: value.currentState.amount0Units, amount1Units: value.currentState.amount1Units },
    proposal: value.proposal === null ? null : { amount0Units: value.proposal.amount0Units, amount1Units: value.proposal.amount1Units, checks: value.proposal.checks.filter((item) => codes.has(item.code)) },
  })
}

function constraintView(value: RangePilotEvaluationArtifact | RangePilotExpected): string {
  const codes = new Set(["COOLDOWN", "GAS_BUDGET", "SLIPPAGE_BOUND"])
  return canonicalJson(value.proposal === null ? null : { maximumSlippageBps: value.proposal.maximumSlippageBps, gasEstimateWei: value.proposal.gasEstimateWei, eligible: value.proposal.eligible, checks: value.proposal.checks.filter((item) => codes.has(item.code)) })
}

function decisionView(value: RangePilotEvaluationArtifact | RangePilotExpected): string {
  return canonicalJson({ status: value.status, reasonCode: value.reasonCode, decision: value.decision, proposalPresent: value.proposal !== null, eligible: value.proposal?.eligible ?? null })
}

function dimension(id: string, label: string, scores: readonly [CandidateScores, CandidateScores], key: ScoreKey): RawDimensionScore {
  return { id, label, toleranceBps: 0, agent: scores[0][key], baseline: scores[1][key] }
}

function failed(rationale: string): CandidateScores {
  const score = { scoreBps: 0, rationale }
  return { contract: score, position: score, ticks: score, amounts: score, constraints: score, decision: score }
}

function binary(value: boolean, success: string, failure: string): { scoreBps: number; rationale: string } {
  return { scoreBps: value ? 10_000 : 0, rationale: value ? success : failure }
}
