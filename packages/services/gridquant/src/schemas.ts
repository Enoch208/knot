import { z } from "zod"

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
const bps = z.number().int().min(0).max(10_000)
const token = z.object({ address, decimals: z.number().int().min(0).max(36) }).strict()

export const gridQuantRequest = z
  .object({
    schemaVersion: z.literal("knot.gridquant.request/1"),
    pair: z
      .object({
        chainId: z.literal(56),
        baseToken: token,
        quoteToken: token,
        pool: address,
      })
      .strict(),
    lowerPriceUnits: units,
    upperPriceUnits: units,
    priceDecimals: z.number().int().min(0).max(36),
    gridCount: z.number().int(),
    spacing: z.enum(["arithmetic", "geometric"]),
    principalQuoteUnits: units,
    orderSizeFloorQuoteUnits: units,
    maxBaseInventoryUnits: units,
    feeAssumptions: z
      .object({
        buyFeeBps: bps,
        sellFeeBps: bps,
        estimatedNetworkFeeQuoteUnitsPerSwap: units,
      })
      .strict(),
    slippageBps: bps,
    cooldownSeconds: z.number().int().min(0).max(31_536_000),
    lastActionUtc: z.iso.datetime().nullable(),
    expiryUtc: z.iso.datetime(),
    evaluatedAtUtc: z.iso.datetime(),
    executionMode: z.enum(["analysis", "conditional-swaps", "limit-orders"]),
  })
  .strict()

const level = z
  .object({
    index: z.number().int().nonnegative(),
    priceUnits: units,
    priceDecimals: z.number().int().min(0).max(36),
    allocatedQuoteUnits: units,
    estimatedBaseUnits: units,
    amountRounding: z.literal("DOWN"),
  })
  .strict()

const timing = z
  .object({
    evaluatedAtUtc: z.iso.datetime(),
    expiryUtc: z.iso.datetime(),
    cooldownSeconds: z.number().int().nonnegative(),
    lastActionUtc: z.iso.datetime().nullable(),
  })
  .strict()

const fillPolicy = z
  .object({
    executionModel: z.literal("OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS"),
    ambiguousFill: z.literal("NO_FILL"),
    sameSideRetrigger: z.literal("REFUSED"),
    requiresObservedReceiptForFill: z.literal(true),
  })
  .strict()

const performance = z
  .object({
    realizedPnlQuoteUnits: z.null(),
    openInventoryMarkToMarketQuoteUnits: z.null(),
    completedTradeCount: z.literal(0),
    basis: z.literal("NO_OBSERVED_FILLS"),
  })
  .strict()

const plan = z
  .object({
    schemaVersion: z.literal("knot.gridquant.result/1"),
    outcome: z.literal("PLAN"),
    capability: z.literal("analysis"),
    pairId: z.literal("bsc:WBNB/USDT:pancakeswap-v3"),
    pair: z
      .object({
        chainId: z.literal(56),
        baseToken: z
          .object({ address, symbol: z.literal("WBNB"), decimals: z.literal(18) })
          .strict(),
        quoteToken: z
          .object({ address, symbol: z.literal("USDT"), decimals: z.literal(18) })
          .strict(),
        pool: address,
        poolFeeBpsPerSwap: z.literal(1),
      })
      .strict(),
    spacing: z.enum(["arithmetic", "geometric"]),
    levels: z.array(level).min(2).max(100),
    capital: z
      .object({
        principalQuoteUnits: units,
        maximumCommittedQuoteUnits: units,
        maximumBaseInventoryUnits: units,
        baseInventoryLimitUnits: units,
      })
      .strict(),
    fees: z
      .object({
        buyFeeBps: bps,
        sellFeeBps: bps,
        slippageBpsPerSwap: bps,
        estimatedRoundTripNetworkFeeQuoteUnits: units,
        minimumGrossAdjacentSpreadBpsFloor: units,
        conservativeBreakEvenBps: units,
      })
      .strict(),
    parameterChecks: z.array(
      z
        .object({
          check: z.enum([
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
          ]),
          status: z.literal("PASS"),
        })
        .strict(),
    ),
    timing,
    fillPolicy,
    historicalEvaluation: z.null(),
    performance,
  })
  .strict()

const noAction = z
  .object({
    schemaVersion: z.literal("knot.gridquant.result/1"),
    outcome: z.literal("NO_ACTION"),
    capability: z.literal("analysis"),
    reason: z.enum(["EXPIRED", "COOLDOWN_ACTIVE"]),
    remainingCooldownSeconds: z.number().int().nonnegative(),
    timing,
    fillPolicy,
    historicalEvaluation: z.null(),
    performance,
  })
  .strict()

const unsupported = z
  .object({
    schemaVersion: z.literal("knot.gridquant.result/1"),
    outcome: z.literal("UNSUPPORTED"),
    capability: z.literal("analysis"),
    reason: z.enum(["PAIR_NOT_ALLOWLISTED", "TOKEN_DECIMALS_MISMATCH", "EXECUTION_NOT_AVAILABLE"]),
    explanation: z.string().min(1),
  })
  .strict()

const rejected = z
  .object({
    schemaVersion: z.literal("knot.gridquant.result/1"),
    outcome: z.literal("REJECTED"),
    capability: z.literal("analysis"),
    reason: z.enum([
      "INVALID_INPUT",
      "INVERTED_BOUNDS",
      "INVALID_GRID_COUNT",
      "INSUFFICIENT_CAPITAL",
      "DUPLICATE_LEVELS",
      "ZERO_BASE_AMOUNT",
      "MAX_INVENTORY_EXCEEDED",
      "FEE_ASSUMPTION_UNDERSTATED",
      "FEES_OVERWHELM_SPREAD",
    ]),
    explanation: z.string().min(1),
    details: z.array(z.string()),
  })
  .strict()

export const gridQuantResult = z.discriminatedUnion("outcome", [plan, noAction, unsupported, rejected])

export type GridQuantRequest = z.infer<typeof gridQuantRequest>
export type GridQuantResult = z.infer<typeof gridQuantResult>
