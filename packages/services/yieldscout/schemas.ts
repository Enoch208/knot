import { z } from "zod"
import { address, baseUnits, hexDigest } from "../../contracts/src/primitives.ts"

const positiveBaseUnits = baseUnits.refine((value) => BigInt(value) > 0n, "expected a positive integer string")
const protocol = z.enum(["venus", "aave-v3"])
const integrationId = z.enum(["venus-core-supply-v1", "aave-v3-bsc-supply-v1"])
const actionState = z.enum(["active", "paused", "unknown"])

const asset = z
  .object({
    chainId: z.literal(56),
    address,
    symbol: z.string().min(1).max(16),
    decimals: z.number().int().min(0).max(36),
  })
  .strict()

const periodBasis = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("per_second"),
      periodsPerYear: z.literal("31536000"),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("per_block"),
      periodsPerYear: positiveBaseUnits,
      source: z.string().min(1),
    })
    .strict(),
])

const incentiveRate = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("valued"),
      ratePerPeriodRay: baseUnits,
      valuationSource: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("none") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
])

const capacity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncapped"), supplyCapUnits: z.null() }).strict(),
  z.object({ kind: z.literal("capped"), supplyCapUnits: baseUnits }).strict(),
  z.object({ kind: z.literal("unknown"), supplyCapUnits: z.null() }).strict(),
])

const marketSnapshot = z
  .object({
    marketId: z.string().min(1),
    integrationId,
    protocol,
    marketAddress: address,
    asset,
    dataStatus: z.enum(["current", "unknown"]),
    observedAtUtc: z.iso.datetime().nullable(),
    periodBasis,
    baseRatePerPeriodRay: baseUnits,
    incentiveRate,
    availableLiquidityUnits: baseUnits.nullable(),
    capacity,
    totalSuppliedUnits: baseUnits,
    supplyState: actionState,
    withdrawalState: actionState,
    exposure: z.enum(["same_asset", "lp"]),
    leverage: z.boolean(),
    concentrationBps: z.number().int().min(0).max(10_000).nullable(),
    entryCostUnits: baseUnits,
    exitCostUnits: baseUnits,
    uncertainty: z.array(z.string().min(1)),
  })
  .strict()

const costValuation = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("current"),
      asset,
      observedAtUtc: z.iso.datetime(),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      asset,
      observedAtUtc: z.null(),
      source: z.null(),
    })
    .strict(),
])

export const yieldScoutRequest = z
  .object({
    schemaVersion: z.literal("knot.yield.request/1"),
    taskId: z.string().min(1),
    asset,
    amountUnits: positiveBaseUnits,
    holdingHorizonSeconds: z.number().int().min(1).max(315_360_000),
    allowedProtocols: z.array(protocol).min(1),
    currentMarketId: z.string().min(1),
    withdrawalNeedsUnits: baseUnits,
    minimumLiquidityUnits: baseUnits,
    concentrationCapBps: z.number().int().min(1).max(10_000),
    gasAllowanceUnits: baseUnits,
    minimumImprovementUnits: baseUnits,
    noLpExposure: z.literal(true),
    maxSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    snapshot: z
      .object({
        schemaVersion: z.literal("knot.yield.snapshot/1"),
        snapshotId: z.string().min(1),
        chainId: z.literal(56),
        blockNumber: positiveBaseUnits,
        blockHash: hexDigest,
        capturedAtUtc: z.iso.datetime(),
        canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
        asset,
        costValuation,
        markets: z.array(marketSnapshot).min(2),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedProtocols).size !== value.allowedProtocols.length) {
      context.addIssue({ code: "custom", path: ["allowedProtocols"], message: "protocols must be unique" })
    }
    const marketIds = value.snapshot.markets.map((market) => market.marketId)
    if (new Set(marketIds).size !== marketIds.length) {
      context.addIssue({ code: "custom", path: ["snapshot", "markets"], message: "market IDs must be unique" })
    }
  })

const comparison = z
  .object({
    marketId: z.string(),
    protocol,
    integrationId,
    baseAnnualRateRay: baseUnits,
    incentiveAnnualRateRay: baseUnits,
    horizonBaseBenefitUnits: baseUnits,
    horizonIncentiveBenefitUnits: baseUnits,
    entryCostUnits: baseUnits,
    exitCostUnits: baseUnits,
    sourceExitCostUnits: baseUnits,
    netBenefitUnits: z.string().regex(/^-?[0-9]+$/),
    improvementVsHoldUnits: z.string().regex(/^-?[0-9]+$/),
    uncertainty: z.array(z.string()),
  })
  .strict()

export const yieldScoutArtifact = z
  .object({
    schemaVersion: z.literal("knot.yield.artifact/1"),
    category: z.literal("yield"),
    capability: z.literal("analysis"),
    taskId: z.string().nullable(),
    status: z.enum([
      "ASSESSED",
      "NO_ACTION",
      "NO_ALTERNATIVE",
      "STALE_SNAPSHOT",
      "ASSESSMENT_INCOMPLETE",
      "UNSUPPORTED_POSITION",
      "INVALID_REQUEST",
    ]),
    reasonCode: z.string().nullable(),
    assessedAtUtc: z.iso.datetime(),
    snapshotId: z.string().nullable(),
    currentMarketId: z.string().nullable(),
    selectedMarketId: z.string().nullable(),
    eligibleMarkets: z.array(comparison),
    excludedMarkets: z.array(z.object({ marketId: z.string(), reasons: z.array(z.string()).min(1) }).strict()),
    recommendation: z.enum(["HOLD", "MIGRATE", "REFUSED"]),
    recommendationReason: z.string(),
    assumptions: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict()

export type YieldScoutRequest = z.infer<typeof yieldScoutRequest>
export type YieldScoutArtifact = z.infer<typeof yieldScoutArtifact>
export type YieldMarketSnapshot = YieldScoutRequest["snapshot"]["markets"][number]
