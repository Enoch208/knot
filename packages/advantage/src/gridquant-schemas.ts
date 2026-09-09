import { z } from "zod"

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as `0x${string}`)
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as `0x${string}`)
const utc = z.iso.datetime()
const bps = z.number().int().min(0).max(10_000)
const token = z
  .object({
    address,
    symbol: z.string().min(1).max(16),
    decimals: z.number().int().min(0).max(36),
    mechanics: z.enum(["plain_erc20", "fee_on_transfer", "rebasing", "unknown"]),
  })
  .strict()
const pair = z.object({ chainId: z.literal(56), baseToken: token, quoteToken: token, pool: address }).strict()
const parameters = z
  .object({
    lowerPriceUnits: units,
    upperPriceUnits: units,
    priceDecimals: z.number().int().min(0).max(36),
    gridCount: z.number().int(),
    spacing: z.enum(["arithmetic", "geometric"]),
    principalQuoteUnits: units,
    orderSizeFloorQuoteUnits: units,
    maxBaseInventoryUnits: units,
    feeAssumptions: z.object({ buyFeeBps: bps, sellFeeBps: bps }).strict(),
    slippageBps: bps,
    cooldownSeconds: z.number().int().min(0).max(31_536_000),
    expiryUtc: utc,
    executionMode: z.enum(["analysis", "conditional-swaps", "limit-orders"]),
  })
  .strict()

export const gridQuantEvaluationInput = z
  .object({
    schemaVersion: z.literal("knot.gridquant.request/2"),
    task: z
      .object({
        schemaVersion: z.literal("knot.gridquant.task/1"),
        taskId: z.string().min(1),
        category: z.literal("grid"),
        capability: z.enum(["analysis", "monitoring", "execution"]),
        identityChainId: z.literal(97),
        dataChainId: z.literal(56),
        paymentChainId: z.literal(97),
        executionChainId: z.null(),
        requester: address,
        pair,
        parameters,
        snapshotId: z.string().min(1),
      })
      .strict(),
    snapshot: z
      .object({
        schemaVersion: z.literal("knot.gridquant.snapshot/1"),
        snapshotId: z.string().min(1),
        chainId: z.literal(56),
        blockNumber: units,
        blockHash: digest,
        blockTimestampUtc: utc,
        capturedAtUtc: utc,
        canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
        sources: z.array(z.object({ uri: z.string().min(1), contentHash: digest, method: z.string().min(1) }).strict()).min(1),
        requester: address,
        analysisAuthorized: z.boolean(),
        pair,
        lastActionUtc: utc.nullable(),
        gasEstimate: z
          .object({
            gasUnits: units,
            gasPriceWei: units,
            nativeTokenPriceQuoteUnits: units,
            estimatedNetworkFeeQuoteUnitsPerSwap: units,
            estimatedAtUtc: utc,
            method: z.string().min(1),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    maxSnapshotAgeSeconds: z.number().int().positive().max(300).default(15),
  })
  .strict()

const timing = z.object({ evaluatedAtUtc: utc, expiryUtc: utc, cooldownSeconds: z.number().int().nonnegative(), lastActionUtc: utc.nullable() }).strict()
const fillPolicy = z.object({ executionModel: z.literal("OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS"), ambiguousFill: z.literal("NO_FILL"), sameSideRetrigger: z.literal("REFUSED"), requiresObservedReceiptForFill: z.literal(true) }).strict()
const performance = z.object({ realizedPnlQuoteUnits: z.null(), openInventoryMarkToMarketQuoteUnits: z.null(), completedTradeCount: z.literal(0), basis: z.literal("NO_OBSERVED_FILLS") }).strict()
const level = z
  .object({ index: z.number().int().nonnegative(), priceUnits: units, priceDecimals: z.number().int().min(0).max(36), allocatedQuoteUnits: units, estimatedBaseUnits: units, amountRounding: z.literal("DOWN") })
  .strict()
const plan = z
  .object({
    outcome: z.literal("PLAN"),
    pairId: z.literal("bsc:WBNB/USDT:pancakeswap-v3"),
    spacing: z.enum(["arithmetic", "geometric"]),
    levels: z.array(level).min(2).max(100),
    capital: z.object({ principalQuoteUnits: units, maximumCommittedQuoteUnits: units, maximumBaseInventoryUnits: units, baseInventoryLimitUnits: units }).strict(),
    fees: z.object({ buyFeeBps: bps, sellFeeBps: bps, slippageBpsPerSwap: bps, estimatedRoundTripNetworkFeeQuoteUnits: units, minimumGrossAdjacentSpreadBpsFloor: units, conservativeBreakEvenBps: units }).strict(),
    parameterChecks: z.array(z.string().min(1)).length(12),
  })
  .strict()
const noAction = z.object({ outcome: z.literal("NO_ACTION"), reason: z.enum(["EXPIRED", "COOLDOWN_ACTIVE"]), remainingCooldownSeconds: z.number().int().nonnegative() }).strict()
const result = z.discriminatedUnion("outcome", [plan, noAction])
const evidence = z.object({ snapshotId: z.string().min(1), chainId: z.literal(56), blockNumber: units, blockHash: digest, blockTimestampUtc: utc, capturedAtUtc: utc, gasEstimatedAtUtc: utc.nullable(), sources: z.array(z.string().min(1)).min(1) }).strict()

export const gridQuantEvaluationArtifact = z
  .object({
    schemaVersion: z.literal("knot.gridquant.artifact/1"),
    category: z.literal("grid"),
    capability: z.literal("analysis"),
    taskId: z.string().min(1).nullable(),
    status: z.enum(["ANALYZED", "NO_ACTION", "PLAN_REJECTED", "STALE_SNAPSHOT", "UNSUPPORTED_POSITION", "INVALID_REQUEST"]),
    reasonCode: z.enum(["AUTHORITY_MISMATCH", "COOLDOWN_ACTIVE", "DUPLICATE_LEVELS", "EXECUTION_NOT_AVAILABLE", "EXPIRED", "FEES_OVERWHELM_SPREAD", "FEE_ASSUMPTION_UNDERSTATED", "GAS_EVIDENCE_MISMATCH", "GAS_EVIDENCE_UNAVAILABLE", "INSUFFICIENT_CAPITAL", "INVALID_GRID_COUNT", "INVALID_JSON", "INVERTED_BOUNDS", "MAX_INVENTORY_EXCEEDED", "PAIR_NOT_ALLOWLISTED", "PLAN", "SCHEMA_VALIDATION_FAILED", "SNAPSHOT_PAIR_MISMATCH", "SNAPSHOT_TARGET_MISMATCH", "STALE_SNAPSHOT", "TOKEN_DECIMALS_MISMATCH", "TOKEN_MECHANICS_UNSUPPORTED", "TOKEN_METADATA_MISMATCH", "ZERO_BASE_AMOUNT"]),
    assessedAtUtc: utc,
    evidence: evidence.nullable(),
    timing: timing.nullable(),
    result: result.nullable(),
    fillPolicy,
    historicalEvaluation: z.null(),
    performance,
    limitations: z.array(z.string().min(1)),
  })
  .strict()

export type GridQuantEvaluationInput = z.infer<typeof gridQuantEvaluationInput>
export type GridQuantEvaluationArtifact = z.infer<typeof gridQuantEvaluationArtifact>
export type GridQuantEvaluationResult = z.infer<typeof result>
