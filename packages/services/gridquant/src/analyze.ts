import { z } from "zod"
import { allocateUnits, arithmeticLevels, ceilDivide, geometricLevels, quoteToBaseUnits } from "./math.ts"
import {
  fillPolicy,
  GRIDQUANT_PAIR,
  isAllowlistedPair,
  performance,
  rejected,
  result,
  timingFor,
  unsupported,
} from "./model.ts"
import { gridQuantRequest, type GridQuantResult } from "./schemas.ts"

const malformed = (error: z.ZodError): GridQuantResult =>
  rejected(
    "INVALID_INPUT",
    "The request does not match the closed GridQuant request schema.",
    error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
  )

export const analyzeGridQuant = (input: unknown): GridQuantResult => {
  const parsed = gridQuantRequest.safeParse(input)
  if (!parsed.success) return malformed(parsed.error)
  const request = parsed.data

  if (!isAllowlistedPair(request)) {
    return unsupported(
      "PAIR_NOT_ALLOWLISTED",
      "Only the allowlisted BSC WBNB/USDT PancakeSwap V3 spot pair is supported.",
    )
  }
  if (request.pair.baseToken.decimals !== GRIDQUANT_PAIR.baseDecimals || request.pair.quoteToken.decimals !== GRIDQUANT_PAIR.quoteDecimals) {
    return unsupported("TOKEN_DECIMALS_MISMATCH", "Token decimals must match the independently configured allowlist metadata.")
  }
  if (request.executionMode !== "analysis") {
    return unsupported(
      "EXECUTION_NOT_AVAILABLE",
      "GridQuant currently produces analysis only and cannot sign, place, trigger, or cancel orders.",
    )
  }
  if (
    request.feeAssumptions.buyFeeBps < GRIDQUANT_PAIR.poolFeeBpsPerSwap ||
    request.feeAssumptions.sellFeeBps < GRIDQUANT_PAIR.poolFeeBpsPerSwap
  ) {
    return rejected(
      "FEE_ASSUMPTION_UNDERSTATED",
      "Buy and sell fee assumptions cannot be lower than the allowlisted pool fee.",
    )
  }

  const lower = BigInt(request.lowerPriceUnits)
  const upper = BigInt(request.upperPriceUnits)
  if (lower === 0n || lower >= upper) return rejected("INVERTED_BOUNDS", "The lower price must be positive and strictly below the upper price.")
  if (request.gridCount < 2 || request.gridCount > 100) return rejected("INVALID_GRID_COUNT", "Grid count must be between 2 and 100 inclusive.")

  const principal = BigInt(request.principalQuoteUnits)
  const floor = BigInt(request.orderSizeFloorQuoteUnits)
  const allocations = allocateUnits(principal, request.gridCount)
  if (principal === 0n || allocations.some((allocation) => allocation < floor || allocation === 0n)) {
    return rejected("INSUFFICIENT_CAPITAL", "Principal cannot fund every level at or above the order-size floor.")
  }

  const levels = request.spacing === "arithmetic"
    ? arithmeticLevels(lower, upper, request.gridCount)
    : geometricLevels(lower, upper, request.gridCount)
  if (new Set(levels.map(String)).size !== levels.length) return rejected("DUPLICATE_LEVELS", "The requested price precision cannot represent distinct levels for these bounds and grid count.")

  const baseAmounts = levels.map((price, index) => quoteToBaseUnits(
    allocations[index] ?? 0n,
    price,
    request.priceDecimals,
    request.pair.baseToken.decimals,
    request.pair.quoteToken.decimals,
  ))
  if (baseAmounts.some((amount) => amount === 0n)) return rejected("ZERO_BASE_AMOUNT", "At least one level rounds to zero base-token units.")
  const maximumBaseInventory = baseAmounts.reduce((sum, amount) => sum + amount, 0n)
  if (maximumBaseInventory > BigInt(request.maxBaseInventoryUnits)) {
    return rejected("MAX_INVENTORY_EXCEEDED", "The conservatively fully-filled ladder exceeds the maximum base-token inventory exposure.")
  }

  const variableCostBps = BigInt(request.feeAssumptions.buyFeeBps + request.feeAssumptions.sellFeeBps + 2 * request.slippageBps)
  const roundTripNetworkFee = BigInt(request.feeAssumptions.estimatedNetworkFeeQuoteUnitsPerSwap) * 2n
  const smallestAllocation = allocations.reduce((smallest, allocation) => allocation < smallest ? allocation : smallest)
  const fixedCostBps = ceilDivide(roundTripNetworkFee * 10_000n, smallestAllocation)
  const breakEvenBps = variableCostBps + fixedCostBps
  const adjacentSpreads = levels.slice(0, -1).map((price, index) => ({ low: price, high: levels[index + 1] ?? price }))
  const minimumGrossSpreadBps = adjacentSpreads.reduce((minimum, spread) => {
    const candidate = ((spread.high - spread.low) * 10_000n) / spread.low
    return candidate < minimum ? candidate : minimum
  }, ((adjacentSpreads[0]?.high ?? upper) - (adjacentSpreads[0]?.low ?? lower)) * 10_000n / (adjacentSpreads[0]?.low ?? lower))
  if (adjacentSpreads.some((spread) => (spread.high - spread.low) * 10_000n <= spread.low * breakEvenBps)) {
    return rejected("FEES_OVERWHELM_SPREAD", "Conservative round-trip fees and slippage equal or exceed at least one adjacent grid spread.")
  }

  const evaluatedAt = Date.parse(request.evaluatedAtUtc)
  const expiry = Date.parse(request.expiryUtc)
  if (expiry <= evaluatedAt) {
    return result({
      schemaVersion: "knot.gridquant.result/1",
      outcome: "NO_ACTION",
      capability: "analysis",
      reason: "EXPIRED",
      remainingCooldownSeconds: 0,
      timing: timingFor(request),
      fillPolicy,
      historicalEvaluation: null,
      performance,
    })
  }
  const lastAction = request.lastActionUtc === null ? null : Date.parse(request.lastActionUtc)
  const remainingCooldownSeconds = lastAction === null ? 0 : Math.max(0, Math.ceil((lastAction + request.cooldownSeconds * 1_000 - evaluatedAt) / 1_000))
  if (remainingCooldownSeconds > 0) {
    return result({
      schemaVersion: "knot.gridquant.result/1",
      outcome: "NO_ACTION",
      capability: "analysis",
      reason: "COOLDOWN_ACTIVE",
      remainingCooldownSeconds,
      timing: timingFor(request),
      fillPolicy,
      historicalEvaluation: null,
      performance,
    })
  }

  const checks = [
    "SUPPORTED_PAIR",
    "SUPPORTED_DECIMALS",
    "ANALYSIS_ONLY",
    "ORDERED_BOUNDS",
    "GRID_COUNT",
    "UNIQUE_LEVELS",
    "CAPITAL_CONSERVED",
    "ORDER_SIZE_FLOOR",
    "INVENTORY_EXPOSURE",
    "FEES_BELOW_SPREAD",
    "NOT_EXPIRED",
    "COOLDOWN_ELAPSED",
  ] as const
  return result({
    schemaVersion: "knot.gridquant.result/1",
    outcome: "PLAN",
    capability: "analysis",
    pairId: "bsc:WBNB/USDT:pancakeswap-v3",
    pair: {
      chainId: GRIDQUANT_PAIR.chainId,
      baseToken: {
        address: GRIDQUANT_PAIR.baseToken,
        symbol: "WBNB",
        decimals: GRIDQUANT_PAIR.baseDecimals,
      },
      quoteToken: {
        address: GRIDQUANT_PAIR.quoteToken,
        symbol: "USDT",
        decimals: GRIDQUANT_PAIR.quoteDecimals,
      },
      pool: GRIDQUANT_PAIR.pool,
      poolFeeBpsPerSwap: GRIDQUANT_PAIR.poolFeeBpsPerSwap,
    },
    spacing: request.spacing,
    levels: levels.map((price, index) => ({
      index,
      priceUnits: price.toString(),
      priceDecimals: request.priceDecimals,
      allocatedQuoteUnits: (allocations[index] ?? 0n).toString(),
      estimatedBaseUnits: (baseAmounts[index] ?? 0n).toString(),
      amountRounding: "DOWN",
    })),
    capital: {
      principalQuoteUnits: request.principalQuoteUnits,
      maximumCommittedQuoteUnits: allocations.reduce((sum, amount) => sum + amount, 0n).toString(),
      maximumBaseInventoryUnits: maximumBaseInventory.toString(),
      baseInventoryLimitUnits: request.maxBaseInventoryUnits,
    },
    fees: {
      buyFeeBps: request.feeAssumptions.buyFeeBps,
      sellFeeBps: request.feeAssumptions.sellFeeBps,
      slippageBpsPerSwap: request.slippageBps,
      estimatedRoundTripNetworkFeeQuoteUnits: roundTripNetworkFee.toString(),
      minimumGrossAdjacentSpreadBpsFloor: minimumGrossSpreadBps.toString(),
      conservativeBreakEvenBps: breakEvenBps.toString(),
    },
    parameterChecks: checks.map((check) => ({ check, status: "PASS" })),
    timing: timingFor(request),
    fillPolicy,
    historicalEvaluation: null,
    performance,
  })
}
