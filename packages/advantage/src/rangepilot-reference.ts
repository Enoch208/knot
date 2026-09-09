import type { RangePilotEvaluationArtifact, RangePilotEvaluationCheck, RangePilotEvaluationInput } from "./rangepilot-schemas.ts"
import { RANGE_MAX_TICK, RANGE_MIN_TICK, rangeAlignedCeil, rangeAlignedFloor, rangeAmountsForLiquidity, rangeSqrtRatioAtTick } from "./rangepilot-tick-math.ts"

export const RANGE_ASSUMPTIONS = [
  "all position, pool, price, liquidity, ownership, and balance fields share the identified block",
  "proposal amounts preserve current position liquidity and use conservative token0 rounding",
  "no future return or narrower-range yield advantage is inferred",
]
export const RANGE_UNAVAILABLE = ["realized fees", "historical time in range", "future yield", "swap price impact"]

export type RangePilotExpected = Pick<RangePilotEvaluationArtifact, "status" | "reasonCode" | "evidence" | "currentState" | "decision" | "proposal" | "assumptions" | "unavailableMetrics">

export function deriveRangePilotExpected(request: RangePilotEvaluationInput, now: Date): RangePilotExpected {
  const evidence = expectedRangeEvidence(request)
  const { task, snapshot } = request
  if (task.capability !== "analysis" || task.constraints.executionMode !== "analysis") return refused("UNSUPPORTED_POSITION", "ANALYSIS_ONLY", evidence)
  if (task.chainId !== 56 || snapshot.chainId !== 56) return refused("UNSUPPORTED_POSITION", "DATA_CHAIN_NOT_SUPPORTED", evidence)
  const identityFailure = rangeIdentityFailure(request)
  if (identityFailure !== null) return refused("UNSUPPORTED_POSITION", identityFailure, evidence)
  const stateFailure = rangeStateFailure(request)
  if (stateFailure !== null) return refused("UNSUPPORTED_POSITION", stateFailure, evidence)
  if (!rangeSnapshotFresh(request, now)) return refused("STALE_SNAPSHOT", "STALE_SNAPSHOT", evidence)
  const liquidity = BigInt(snapshot.position.liquidity)
  const currentAmounts = rangeAmountsForLiquidity(liquidity, BigInt(snapshot.pool.sqrtPriceX96), snapshot.position.tickLower, snapshot.position.tickUpper)
  const condition = snapshot.pool.currentTick >= snapshot.position.tickLower && snapshot.pool.currentTick < snapshot.position.tickUpper ? "IN_RANGE" : "OUT_OF_RANGE"
  const currentState = {
    owner: snapshot.position.owner,
    pool: snapshot.pool.address,
    token0: withoutBalance(snapshot.pool.token0),
    token1: withoutBalance(snapshot.pool.token1),
    currentTick: snapshot.pool.currentTick,
    tickLower: snapshot.position.tickLower,
    tickUpper: snapshot.position.tickUpper,
    tickSpacing: snapshot.pool.tickSpacing,
    liquidity: snapshot.position.liquidity,
    activeLiquidity: snapshot.pool.activeLiquidity,
    amount0Units: currentAmounts.amount0.toString(),
    amount1Units: currentAmounts.amount1.toString(),
    tokensOwed0: snapshot.position.tokensOwed0,
    tokensOwed1: snapshot.position.tokensOwed1,
    condition,
  } as const
  if (condition === "IN_RANGE") return accepted("ANALYZED", "IN_RANGE_HOLD", evidence, currentState, "HOLD", null)
  const bounds = rangeProposalBounds(request)
  const proposalAmounts = rangeAmountsForLiquidity(liquidity, BigInt(snapshot.pool.sqrtPriceX96), bounds.lower, bounds.upper)
  const available0 = BigInt(snapshot.pool.token0.balanceUnits) + currentAmounts.amount0 + BigInt(snapshot.position.tokensOwed0)
  const available1 = BigInt(snapshot.pool.token1.balanceUnits) + currentAmounts.amount1 + BigInt(snapshot.position.tokensOwed1)
  const gasEstimate = snapshot.gasEstimate === null ? null : BigInt(snapshot.gasEstimate.gasUnits) * BigInt(snapshot.gasEstimate.gasPriceWei)
  const checks = rangePlanChecks(request, bounds, proposalAmounts, available0, available1, gasEstimate, now)
  const eligible = checks.every((check) => check.passed)
  const cooldownOnly = !eligible && checks.filter((check) => !check.passed).every((check) => check.code === "COOLDOWN")
  return accepted(
    eligible || cooldownOnly ? "ANALYZED" : "PLAN_REJECTED",
    eligible ? "OUT_OF_RANGE" : cooldownOnly ? "COOLDOWN_ACTIVE" : "PLAN_CONSTRAINTS_FAILED",
    evidence,
    currentState,
    eligible ? "PROPOSE_RANGE" : cooldownOnly ? "HOLD" : "REFUSED",
    {
      tickLower: bounds.lower,
      tickUpper: bounds.upper,
      widthTicks: bounds.upper - bounds.lower,
      liquidity: snapshot.position.liquidity,
      amount0Units: proposalAmounts.amount0.toString(),
      amount1Units: proposalAmounts.amount1.toString(),
      maximumSlippageBps: task.constraints.maximumSlippageBps,
      gasEstimateWei: gasEstimate?.toString() ?? null,
      eligible,
      checks,
    },
  )
}

export function rangeProposalBounds({ task, snapshot }: RangePilotEvaluationInput): { lower: number; upper: number } {
  const spacing = snapshot.pool.tickSpacing
  const intervals = Math.max(2, Math.ceil(task.constraints.targetRangeWidthTicks / spacing))
  const center = rangeAlignedFloor(snapshot.pool.currentTick, spacing)
  const lowerIntervals = Math.floor(intervals / 2)
  const upperIntervals = intervals - lowerIntervals
  const minimum = rangeAlignedCeil(Math.max(RANGE_MIN_TICK, task.allowedPool.minimumTick), spacing)
  const maximum = rangeAlignedFloor(Math.min(RANGE_MAX_TICK, task.allowedPool.maximumTick), spacing)
  let lower = center - lowerIntervals * spacing
  let upper = center + upperIntervals * spacing
  if (lower < minimum) {
    upper += minimum - lower
    lower = minimum
  }
  if (upper > maximum) {
    lower -= upper - maximum
    upper = maximum
  }
  return { lower: Math.max(lower, minimum), upper }
}

export function rangePlanChecks(
  request: RangePilotEvaluationInput,
  bounds: { lower: number; upper: number },
  amounts: { amount0: bigint; amount1: bigint },
  available0: bigint,
  available1: bigint,
  gasEstimate: bigint | null,
  now: Date,
): RangePilotEvaluationCheck[] {
  const { task, snapshot } = request
  const width = bounds.upper - bounds.lower
  const cooldownEnds = snapshot.lastCompletedActionAtUtc === null ? null : Date.parse(snapshot.lastCompletedActionAtUtc) + task.constraints.cooldownSeconds * 1_000
  const tickPassed = bounds.lower < bounds.upper && bounds.lower >= task.allowedPool.minimumTick && bounds.upper <= task.allowedPool.maximumTick && width >= task.constraints.minimumRangeWidthTicks && width <= task.constraints.maximumRangeWidthTicks
  return [
    check("TICK_BOUNDS", tickPassed, `${bounds.lower}:${bounds.upper}:${width}`, `${task.allowedPool.minimumTick}:${task.allowedPool.maximumTick}:${task.constraints.minimumRangeWidthTicks}:${task.constraints.maximumRangeWidthTicks}`),
    check("TOKEN0_BUDGET", amounts.amount0 <= BigInt(task.constraints.token0BudgetUnits), amounts.amount0.toString(), task.constraints.token0BudgetUnits),
    check("TOKEN1_BUDGET", amounts.amount1 <= BigInt(task.constraints.token1BudgetUnits), amounts.amount1.toString(), task.constraints.token1BudgetUnits),
    check("TOKEN0_AVAILABLE", amounts.amount0 <= available0, amounts.amount0.toString(), available0.toString()),
    check("TOKEN1_AVAILABLE", amounts.amount1 <= available1, amounts.amount1.toString(), available1.toString()),
    check("SLIPPAGE_BOUND", task.constraints.maximumSlippageBps <= task.allowedPool.maximumSlippageBps, task.constraints.maximumSlippageBps.toString(), task.allowedPool.maximumSlippageBps.toString()),
    check("GAS_BUDGET", gasEstimate !== null && gasEstimate <= BigInt(task.constraints.gasBudgetWei), gasEstimate?.toString() ?? "unavailable", task.constraints.gasBudgetWei),
    check("COOLDOWN", cooldownEnds === null || cooldownEnds <= now.getTime(), cooldownEnds === null ? "no prior action" : new Date(cooldownEnds).toISOString(), now.toISOString()),
  ]
}

export function expectedRangeEvidence({ snapshot }: RangePilotEvaluationInput): NonNullable<RangePilotEvaluationArtifact["evidence"]> {
  return {
    snapshotId: snapshot.snapshotId,
    chainId: snapshot.chainId,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    blockTimestampUtc: snapshot.blockTimestampUtc,
    capturedAtUtc: snapshot.capturedAtUtc,
    gasEstimatedAtUtc: snapshot.gasEstimate?.estimatedAtUtc ?? null,
  }
}

function rangeIdentityFailure({ task, snapshot }: RangePilotEvaluationInput): string | null {
  const allowed = task.allowedPool
  const pool = snapshot.pool
  const position = snapshot.position
  if (task.snapshotId !== snapshot.snapshotId || task.chainId !== snapshot.chainId) return "SNAPSHOT_TARGET_MISMATCH"
  if (task.positionManager !== snapshot.positionManager || task.positionTokenId !== snapshot.positionTokenId) return "POSITION_IDENTITY_MISMATCH"
  if (position.owner !== task.controllingAccount || snapshot.account.address !== task.controllingAccount) return "OWNER_MISMATCH"
  if (!snapshot.account.canManagePosition) return "AUTHORITY_MISMATCH"
  if (position.pool !== pool.address || pool.address !== allowed.address || pool.factory !== allowed.factory) return "POOL_IDENTITY_MISMATCH"
  if (position.token0 !== pool.token0.address || pool.token0.address !== allowed.token0.address) return "TOKEN0_IDENTITY_MISMATCH"
  if (position.token1 !== pool.token1.address || pool.token1.address !== allowed.token1.address) return "TOKEN1_IDENTITY_MISMATCH"
  if (pool.token0.decimals !== allowed.token0.decimals || pool.token1.decimals !== allowed.token1.decimals) return "TOKEN_DECIMALS_MISMATCH"
  if (pool.token0.symbol !== allowed.token0.symbol || pool.token1.symbol !== allowed.token1.symbol) return "TOKEN_METADATA_MISMATCH"
  if (pool.token0.mechanics !== allowed.token0.mechanics || pool.token1.mechanics !== allowed.token1.mechanics) return "TOKEN_CONFIGURATION_MISMATCH"
  if (position.feeTier !== pool.feeTier || pool.feeTier !== allowed.feeTier || pool.tickSpacing !== allowed.tickSpacing) return "POOL_CONFIGURATION_MISMATCH"
  return null
}

function rangeStateFailure({ task, snapshot }: RangePilotEvaluationInput): string | null {
  const { position, pool } = snapshot
  if (!pool.initialized) return "POOL_NOT_INITIALIZED"
  if (position.farmed) return "FARMED_POSITION_UNSUPPORTED"
  if (pool.hasHooks) return "HOOKS_UNSUPPORTED"
  if (pool.token0.mechanics !== "plain_erc20" || pool.token1.mechanics !== "plain_erc20") return "TOKEN_MECHANICS_UNSUPPORTED"
  if (BigInt(position.liquidity) === 0n) return "EMPTY_POSITION"
  if (BigInt(pool.activeLiquidity) === 0n || BigInt(pool.sqrtPriceX96) === 0n) return "POOL_STATE_INVALID"
  if (position.tickLower >= position.tickUpper) return "POSITION_TICKS_INVALID"
  if (position.tickLower % pool.tickSpacing !== 0 || position.tickUpper % pool.tickSpacing !== 0) return "POSITION_TICKS_UNALIGNED"
  if (position.tickLower < task.allowedPool.minimumTick || position.tickUpper > task.allowedPool.maximumTick) return "POSITION_TICKS_OUT_OF_BOUNDS"
  if (pool.currentTick >= task.allowedPool.maximumTick) return "POOL_TICK_OUT_OF_BOUNDS"
  const price = BigInt(pool.sqrtPriceX96)
  if (price < rangeSqrtRatioAtTick(pool.currentTick) || price >= rangeSqrtRatioAtTick(pool.currentTick + 1)) return "POOL_PRICE_TICK_MISMATCH"
  return null
}

function rangeSnapshotFresh({ snapshot, maxSnapshotAgeSeconds }: RangePilotEvaluationInput, now: Date): boolean {
  const captured = Date.parse(snapshot.capturedAtUtc)
  const block = Date.parse(snapshot.blockTimestampUtc)
  if (snapshot.canonicality !== "confirmed" || captured < block || captured > now.getTime() || now.getTime() - captured > maxSnapshotAgeSeconds * 1_000) return false
  if (snapshot.gasEstimate === null) return true
  const estimated = Date.parse(snapshot.gasEstimate.estimatedAtUtc)
  return estimated <= now.getTime() && now.getTime() - estimated <= maxSnapshotAgeSeconds * 1_000
}

function withoutBalance(token: RangePilotEvaluationInput["snapshot"]["pool"]["token0"]) {
  return { address: token.address, symbol: token.symbol, decimals: token.decimals, mechanics: token.mechanics }
}

function check(code: RangePilotEvaluationCheck["code"], passed: boolean, observed: string, limit: string): RangePilotEvaluationCheck {
  return { code, passed, observed, limit }
}

function accepted(status: RangePilotExpected["status"], reasonCode: string, evidence: RangePilotExpected["evidence"], currentState: NonNullable<RangePilotExpected["currentState"]>, decision: RangePilotExpected["decision"], proposal: RangePilotExpected["proposal"]): RangePilotExpected {
  return { status, reasonCode, evidence, currentState, decision, proposal, assumptions: RANGE_ASSUMPTIONS, unavailableMetrics: RANGE_UNAVAILABLE }
}

function refused(status: RangePilotExpected["status"], reasonCode: string, evidence: RangePilotExpected["evidence"]): RangePilotExpected {
  return { status, reasonCode, evidence, currentState: null, decision: "REFUSED", proposal: null, assumptions: RANGE_ASSUMPTIONS, unavailableMetrics: RANGE_UNAVAILABLE }
}
