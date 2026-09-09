import { gridAllocateUnits, gridArithmeticLevels, gridCeilDivide, gridGeometricLevels, gridQuoteToBase } from "./gridquant-math.ts"
import type { GridQuantEvaluationArtifact, GridQuantEvaluationInput, GridQuantEvaluationResult } from "./gridquant-schemas.ts"

const ALLOWLIST = {
  baseToken: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  quoteToken: "0x55d398326f99059ff775485246999027b3197955",
  pool: "0x172fcd41e0913e95784454622d1c3724f546f849",
  baseSymbol: "WBNB",
  quoteSymbol: "USDT",
  baseDecimals: 18,
  quoteDecimals: 18,
  poolFeeBps: 1,
} as const
export const GRID_FILL_POLICY = { executionModel: "OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS", ambiguousFill: "NO_FILL", sameSideRetrigger: "REFUSED", requiresObservedReceiptForFill: true } as const
export const GRID_PERFORMANCE = { realizedPnlQuoteUnits: null, openInventoryMarkToMarketQuoteUnits: null, completedTradeCount: 0, basis: "NO_OBSERVED_FILLS" } as const
export const GRID_LIMITATIONS = [
  "analysis only; no order, swap, or liquidity transaction is signed",
  "historical performance and future return are unavailable",
  "a grid level is not a fill without an observed transaction receipt",
]

export type GridQuantExpected = Pick<GridQuantEvaluationArtifact, "status" | "reasonCode" | "evidence" | "timing" | "result" | "fillPolicy" | "historicalEvaluation" | "performance" | "limitations">

export function deriveGridQuantExpected(request: GridQuantEvaluationInput, now: Date): GridQuantExpected {
  const { task, snapshot } = request
  if (task.capability !== "analysis" || task.parameters.executionMode !== "analysis") return refusal("UNSUPPORTED_POSITION", "EXECUTION_NOT_AVAILABLE", request, now)
  if (task.snapshotId !== snapshot.snapshotId || task.dataChainId !== snapshot.chainId) return refusal("UNSUPPORTED_POSITION", "SNAPSHOT_TARGET_MISMATCH", request, now)
  if (task.requester !== snapshot.requester || !snapshot.analysisAuthorized) return refusal("UNSUPPORTED_POSITION", "AUTHORITY_MISMATCH", request, now)
  if (!samePair(task.pair, snapshot.pair)) return refusal("UNSUPPORTED_POSITION", "SNAPSHOT_PAIR_MISMATCH", request, now)
  if (!allowlisted(task.pair)) return refusal("UNSUPPORTED_POSITION", "PAIR_NOT_ALLOWLISTED", request, now)
  if (task.pair.baseToken.symbol !== ALLOWLIST.baseSymbol || task.pair.quoteToken.symbol !== ALLOWLIST.quoteSymbol) return refusal("UNSUPPORTED_POSITION", "TOKEN_METADATA_MISMATCH", request, now)
  if (task.pair.baseToken.decimals !== ALLOWLIST.baseDecimals || task.pair.quoteToken.decimals !== ALLOWLIST.quoteDecimals) return refusal("UNSUPPORTED_POSITION", "TOKEN_DECIMALS_MISMATCH", request, now)
  if (task.pair.baseToken.mechanics !== "plain_erc20" || task.pair.quoteToken.mechanics !== "plain_erc20") return refusal("UNSUPPORTED_POSITION", "TOKEN_MECHANICS_UNSUPPORTED", request, now)
  if (!gridSnapshotFresh(request, now)) return refusal("STALE_SNAPSHOT", "STALE_SNAPSHOT", request, now)
  if (snapshot.gasEstimate === null) return refusal("PLAN_REJECTED", "GAS_EVIDENCE_UNAVAILABLE", request, now)
  const gasCost = BigInt(snapshot.gasEstimate.gasUnits) * BigInt(snapshot.gasEstimate.gasPriceWei) * BigInt(snapshot.gasEstimate.nativeTokenPriceQuoteUnits) / 10n ** 18n
  if (gasCost.toString() !== snapshot.gasEstimate.estimatedNetworkFeeQuoteUnitsPerSwap) return refusal("PLAN_REJECTED", "GAS_EVIDENCE_MISMATCH", request, now)
  const parameters = task.parameters
  if (parameters.feeAssumptions.buyFeeBps < ALLOWLIST.poolFeeBps || parameters.feeAssumptions.sellFeeBps < ALLOWLIST.poolFeeBps) return refusal("PLAN_REJECTED", "FEE_ASSUMPTION_UNDERSTATED", request, now)
  const lower = BigInt(parameters.lowerPriceUnits)
  const upper = BigInt(parameters.upperPriceUnits)
  if (lower === 0n || lower >= upper) return refusal("PLAN_REJECTED", "INVERTED_BOUNDS", request, now)
  if (parameters.gridCount < 2 || parameters.gridCount > 100) return refusal("PLAN_REJECTED", "INVALID_GRID_COUNT", request, now)
  const principal = BigInt(parameters.principalQuoteUnits)
  const allocations = gridAllocateUnits(principal, parameters.gridCount)
  if (principal === 0n || allocations.some((amount) => amount === 0n || amount < BigInt(parameters.orderSizeFloorQuoteUnits))) return refusal("PLAN_REJECTED", "INSUFFICIENT_CAPITAL", request, now)
  const levels = parameters.spacing === "arithmetic" ? gridArithmeticLevels(lower, upper, parameters.gridCount) : gridGeometricLevels(lower, upper, parameters.gridCount)
  if (new Set(levels.map(String)).size !== levels.length) return refusal("PLAN_REJECTED", "DUPLICATE_LEVELS", request, now)
  const baseAmounts = levels.map((price, index) => gridQuoteToBase(allocations[index] ?? 0n, price, parameters.priceDecimals, ALLOWLIST.baseDecimals, ALLOWLIST.quoteDecimals))
  if (baseAmounts.some((amount) => amount === 0n)) return refusal("PLAN_REJECTED", "ZERO_BASE_AMOUNT", request, now)
  const maximumInventory = baseAmounts.reduce((sum, amount) => sum + amount, 0n)
  if (maximumInventory > BigInt(parameters.maxBaseInventoryUnits)) return refusal("PLAN_REJECTED", "MAX_INVENTORY_EXCEEDED", request, now)
  const variableCostBps = BigInt(parameters.feeAssumptions.buyFeeBps + parameters.feeAssumptions.sellFeeBps + 2 * parameters.slippageBps)
  const roundTripNetworkFee = BigInt(snapshot.gasEstimate.estimatedNetworkFeeQuoteUnitsPerSwap) * 2n
  const smallestAllocation = allocations.reduce((smallest, amount) => amount < smallest ? amount : smallest)
  const breakEvenBps = variableCostBps + gridCeilDivide(roundTripNetworkFee * 10_000n, smallestAllocation)
  const spreads = levels.slice(0, -1).map((price, index) => ({ low: price, high: levels[index + 1] ?? price }))
  const minimumGrossSpreadBps = spreads.map((spread) => (spread.high - spread.low) * 10_000n / spread.low).reduce((minimum, candidate) => candidate < minimum ? candidate : minimum)
  if (spreads.some((spread) => (spread.high - spread.low) * 10_000n <= spread.low * breakEvenBps)) return refusal("PLAN_REJECTED", "FEES_OVERWHELM_SPREAD", request, now)
  if (Date.parse(parameters.expiryUtc) <= now.getTime()) return accepted("NO_ACTION", "EXPIRED", request, now, { outcome: "NO_ACTION", reason: "EXPIRED", remainingCooldownSeconds: 0 })
  const lastAction = snapshot.lastActionUtc === null ? null : Date.parse(snapshot.lastActionUtc)
  const remainingCooldownSeconds = lastAction === null ? 0 : Math.max(0, Math.ceil((lastAction + parameters.cooldownSeconds * 1_000 - now.getTime()) / 1_000))
  if (remainingCooldownSeconds > 0) return accepted("NO_ACTION", "COOLDOWN_ACTIVE", request, now, { outcome: "NO_ACTION", reason: "COOLDOWN_ACTIVE", remainingCooldownSeconds })
  return accepted("ANALYZED", "PLAN", request, now, {
    outcome: "PLAN",
    pairId: "bsc:WBNB/USDT:pancakeswap-v3",
    spacing: parameters.spacing,
    levels: levels.map((price, index) => ({ index, priceUnits: price.toString(), priceDecimals: parameters.priceDecimals, allocatedQuoteUnits: (allocations[index] ?? 0n).toString(), estimatedBaseUnits: (baseAmounts[index] ?? 0n).toString(), amountRounding: "DOWN" })),
    capital: { principalQuoteUnits: parameters.principalQuoteUnits, maximumCommittedQuoteUnits: allocations.reduce((sum, amount) => sum + amount, 0n).toString(), maximumBaseInventoryUnits: maximumInventory.toString(), baseInventoryLimitUnits: parameters.maxBaseInventoryUnits },
    fees: { buyFeeBps: parameters.feeAssumptions.buyFeeBps, sellFeeBps: parameters.feeAssumptions.sellFeeBps, slippageBpsPerSwap: parameters.slippageBps, estimatedRoundTripNetworkFeeQuoteUnits: roundTripNetworkFee.toString(), minimumGrossAdjacentSpreadBpsFloor: minimumGrossSpreadBps.toString(), conservativeBreakEvenBps: breakEvenBps.toString() },
    parameterChecks: ["SUPPORTED_PAIR", "SUPPORTED_DECIMALS", "ANALYSIS_ONLY", "PINNED_SNAPSHOT", "AUTHORIZED_ANALYSIS", "ORDERED_BOUNDS", "GRID_COUNT", "UNIQUE_LEVELS", "CAPITAL_CONSERVED", "INVENTORY_EXPOSURE", "FEES_BELOW_SPREAD", "COOLDOWN_ELAPSED"],
  })
}

function gridSnapshotFresh({ snapshot, maxSnapshotAgeSeconds }: GridQuantEvaluationInput, now: Date): boolean {
  const capturedAt = Date.parse(snapshot.capturedAtUtc)
  const blockAt = Date.parse(snapshot.blockTimestampUtc)
  if (snapshot.canonicality !== "confirmed" || capturedAt < blockAt || capturedAt > now.getTime() || now.getTime() - capturedAt > maxSnapshotAgeSeconds * 1_000) return false
  if (snapshot.gasEstimate === null) return true
  const estimatedAt = Date.parse(snapshot.gasEstimate.estimatedAtUtc)
  return estimatedAt <= now.getTime() && now.getTime() - estimatedAt <= maxSnapshotAgeSeconds * 1_000
}

function samePair(left: GridQuantEvaluationInput["task"]["pair"], right: GridQuantEvaluationInput["snapshot"]["pair"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function allowlisted(pair: GridQuantEvaluationInput["task"]["pair"]): boolean {
  return pair.chainId === 56 && pair.baseToken.address === ALLOWLIST.baseToken && pair.quoteToken.address === ALLOWLIST.quoteToken && pair.pool === ALLOWLIST.pool
}

function evidence({ snapshot }: GridQuantEvaluationInput) {
  return { snapshotId: snapshot.snapshotId, chainId: snapshot.chainId, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, blockTimestampUtc: snapshot.blockTimestampUtc, capturedAtUtc: snapshot.capturedAtUtc, gasEstimatedAtUtc: snapshot.gasEstimate?.estimatedAtUtc ?? null, sources: snapshot.sources.map((source) => source.uri) }
}

function timing({ task, snapshot }: GridQuantEvaluationInput, now: Date) {
  return { evaluatedAtUtc: now.toISOString(), expiryUtc: task.parameters.expiryUtc, cooldownSeconds: task.parameters.cooldownSeconds, lastActionUtc: snapshot.lastActionUtc }
}

function accepted(status: GridQuantExpected["status"], reasonCode: GridQuantExpected["reasonCode"], request: GridQuantEvaluationInput, now: Date, result: GridQuantEvaluationResult): GridQuantExpected {
  return { status, reasonCode, evidence: evidence(request), timing: timing(request, now), result, fillPolicy: GRID_FILL_POLICY, historicalEvaluation: null, performance: GRID_PERFORMANCE, limitations: GRID_LIMITATIONS }
}

function refusal(status: GridQuantExpected["status"], reasonCode: GridQuantExpected["reasonCode"], request: GridQuantEvaluationInput, now: Date): GridQuantExpected {
  return { status, reasonCode, evidence: evidence(request), timing: timing(request, now), result: null, fillPolicy: GRID_FILL_POLICY, historicalEvaluation: null, performance: GRID_PERFORMANCE, limitations: GRID_LIMITATIONS }
}
