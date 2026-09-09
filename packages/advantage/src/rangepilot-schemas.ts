import { z } from "zod"

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as `0x${string}`)
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as `0x${string}`)
const utc = z.iso.datetime({ offset: true })
const chainId = z.union([z.literal(56), z.literal(97)])
const tick = z.number().int().min(-887272).max(887272)
const token = z
  .object({
    address,
    symbol: z.string().min(1).max(32),
    decimals: z.number().int().min(0).max(36),
    mechanics: z.enum(["plain_erc20", "fee_on_transfer", "rebasing", "unknown"]),
  })
  .strict()
const source = z.object({ uri: z.string().min(1), contentHash: digest, method: z.string().min(1) }).strict()
const allowedPool = z
  .object({
    address,
    factory: address,
    token0: token,
    token1: token,
    feeTier: z.number().int().positive().max(1_000_000),
    tickSpacing: z.number().int().positive().max(887272),
    minimumTick: tick,
    maximumTick: tick,
    maximumSlippageBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine((value) => value.minimumTick < value.maximumTick)
const rangeTask = z
  .object({
    schemaVersion: z.literal("knot.rangepilot.task/1"),
    taskId: z.string().min(1),
    category: z.literal("rebalancing"),
    capability: z.enum(["analysis", "monitoring", "execution"]),
    chainId,
    positionManager: address,
    positionTokenId: baseUnits,
    controllingAccount: address,
    allowedPool,
    constraints: z
      .object({
        token0BudgetUnits: baseUnits,
        token1BudgetUnits: baseUnits,
        minimumRangeWidthTicks: z.number().int().positive().max(1_774_544),
        targetRangeWidthTicks: z.number().int().positive().max(1_774_544),
        maximumRangeWidthTicks: z.number().int().positive().max(1_774_544),
        maximumSlippageBps: z.number().int().min(0).max(10_000),
        gasBudgetWei: baseUnits,
        cooldownSeconds: z.number().int().min(0).max(31_536_000),
        executionMode: z.enum(["analysis", "reviewed", "unattended"]),
      })
      .strict(),
    snapshotId: z.string().min(1),
  })
  .strict()
  .refine((value) => value.constraints.minimumRangeWidthTicks <= value.constraints.targetRangeWidthTicks && value.constraints.targetRangeWidthTicks <= value.constraints.maximumRangeWidthTicks)
const snapshotToken = token.extend({ balanceUnits: baseUnits }).strict()
const snapshot = z
  .object({
    schemaVersion: z.literal("knot.rangepilot.snapshot/1"),
    snapshotId: z.string().min(1),
    chainId,
    blockNumber: baseUnits,
    blockHash: digest,
    blockTimestampUtc: utc,
    capturedAtUtc: utc,
    canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
    sources: z.array(source).min(1),
    positionManager: address,
    positionTokenId: baseUnits,
    position: z
      .object({
        owner: address,
        pool: address,
        token0: address,
        token1: address,
        feeTier: z.number().int().positive().max(1_000_000),
        tickLower: tick,
        tickUpper: tick,
        liquidity: baseUnits,
        feeGrowthInside0LastX128: baseUnits,
        feeGrowthInside1LastX128: baseUnits,
        tokensOwed0: baseUnits,
        tokensOwed1: baseUnits,
        farmed: z.boolean(),
      })
      .strict(),
    pool: z
      .object({
        protocol: z.literal("pancakeswap-v3"),
        address,
        factory: address,
        token0: snapshotToken,
        token1: snapshotToken,
        feeTier: z.number().int().positive().max(1_000_000),
        tickSpacing: z.number().int().positive().max(887272),
        currentTick: tick,
        sqrtPriceX96: baseUnits,
        activeLiquidity: baseUnits,
        initialized: z.boolean(),
        hasHooks: z.boolean(),
      })
      .strict(),
    account: z.object({ address, canManagePosition: z.boolean() }).strict(),
    lastCompletedActionAtUtc: utc.nullable(),
    gasEstimate: z.object({ gasUnits: baseUnits, gasPriceWei: baseUnits, estimatedAtUtc: utc, method: z.string().min(1) }).strict().nullable(),
  })
  .strict()

export const rangePilotEvaluationInput = z
  .object({
    schemaVersion: z.literal("knot.rangepilot.request/1"),
    task: rangeTask,
    snapshot,
    maxSnapshotAgeSeconds: z.number().int().positive().max(300).default(15),
  })
  .strict()

const planCheck = z
  .object({
    code: z.enum(["COOLDOWN", "GAS_BUDGET", "SLIPPAGE_BOUND", "TICK_BOUNDS", "TOKEN0_AVAILABLE", "TOKEN0_BUDGET", "TOKEN1_AVAILABLE", "TOKEN1_BUDGET"]),
    passed: z.boolean(),
    observed: z.string(),
    limit: z.string(),
  })
  .strict()
const proposal = z
  .object({
    tickLower: tick,
    tickUpper: tick,
    widthTicks: z.number().int().positive(),
    liquidity: baseUnits,
    amount0Units: baseUnits,
    amount1Units: baseUnits,
    maximumSlippageBps: z.number().int().min(0).max(10_000),
    gasEstimateWei: baseUnits.nullable(),
    eligible: z.boolean(),
    checks: z.array(planCheck).length(8),
  })
  .strict()

export const rangePilotEvaluationArtifact = z
  .object({
    schemaVersion: z.literal("knot.rangepilot.artifact/1"),
    category: z.literal("rebalancing"),
    capability: z.literal("analysis"),
    taskId: z.string().min(1).nullable(),
    status: z.enum(["ANALYZED", "INVALID_REQUEST", "PLAN_REJECTED", "STALE_SNAPSHOT", "UNSUPPORTED_POSITION"]),
    reasonCode: z.string().min(1),
    assessedAtUtc: utc,
    evidence: z.object({ snapshotId: z.string().min(1), chainId, blockNumber: baseUnits, blockHash: digest, blockTimestampUtc: utc, capturedAtUtc: utc, gasEstimatedAtUtc: utc.nullable() }).strict().nullable(),
    currentState: z
      .object({
        owner: address,
        pool: address,
        token0: token,
        token1: token,
        currentTick: tick,
        tickLower: tick,
        tickUpper: tick,
        tickSpacing: z.number().int().positive(),
        liquidity: baseUnits,
        activeLiquidity: baseUnits,
        amount0Units: baseUnits,
        amount1Units: baseUnits,
        tokensOwed0: baseUnits,
        tokensOwed1: baseUnits,
        condition: z.enum(["IN_RANGE", "OUT_OF_RANGE"]),
      })
      .strict()
      .nullable(),
    decision: z.enum(["HOLD", "PROPOSE_RANGE", "REFUSED"]),
    proposal: proposal.nullable(),
    assumptions: z.array(z.string().min(1)),
    unavailableMetrics: z.array(z.string().min(1)),
  })
  .strict()

export type RangePilotEvaluationInput = z.infer<typeof rangePilotEvaluationInput>
export type RangePilotEvaluationArtifact = z.infer<typeof rangePilotEvaluationArtifact>
export type RangePilotEvaluationProposal = z.infer<typeof proposal>
export type RangePilotEvaluationCheck = z.infer<typeof planCheck>
