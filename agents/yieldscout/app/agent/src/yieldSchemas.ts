import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const positiveBaseUnits = baseUnits.refine((value) => BigInt(value) > 0n);
const digest = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);
const utc = z.string().datetime({ offset: true });
const protocol = z.enum(["venus", "aave-v3"]);
const integrationId = z.enum(["venus-core-supply-v1", "aave-v3-bsc-supply-v1"]);
const actionState = z.enum(["active", "paused", "unknown"]);
const source = z
  .object({ uri: z.string().min(1), contentHash: digest, method: z.string().min(1) })
  .strict();
const asset = z
  .object({
    chainId: z.literal(56),
    address,
    symbol: z.string().min(1).max(16),
    decimals: z.number().int().min(0).max(36),
    mechanics: z.enum(["plain_erc20", "fee_on_transfer", "rebasing", "unknown"]),
  })
  .strict();
const periodBasis = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("per_second"), periodsPerYear: z.literal("31536000"), source })
    .strict(),
  z
    .object({ kind: z.literal("per_block"), periodsPerYear: positiveBaseUnits, source })
    .strict(),
]);
const incentiveRate = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("valued"),
      ratePerPeriodRay: baseUnits,
      observedAtUtc: utc,
      valuationSource: source,
    })
    .strict(),
  z.object({ status: z.literal("none") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
const capacity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncapped"), supplyCapUnits: z.null() }).strict(),
  z.object({ kind: z.literal("capped"), supplyCapUnits: baseUnits }).strict(),
  z.object({ kind: z.literal("unknown"), supplyCapUnits: z.null() }).strict(),
]);
const marketSnapshot = z
  .object({
    marketId: z.string().min(1),
    integrationId,
    protocol,
    marketAddress: address,
    asset,
    dataStatus: z.enum(["current", "unknown"]),
    observedAtUtc: utc.nullable(),
    dataSource: source.nullable(),
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
    riskFlags: z.array(z.enum(["INCIDENT_ACTIVE", "ORACLE_UNCERTAIN", "PROTOCOL_PAUSED"])),
    uncertainty: z.array(z.string().min(1)),
  })
  .strict();
const costValuation = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("current"), asset, observedAtUtc: utc, source })
    .strict(),
  z
    .object({ status: z.literal("unknown"), asset, observedAtUtc: z.null(), source: z.null() })
    .strict(),
]);

export const yieldScoutRequest = z
  .object({
    schemaVersion: z.literal("knot.yield.request/2"),
    taskId: z.string().min(1),
    category: z.literal("yield"),
    capability: z.enum(["analysis", "monitoring", "execution"]),
    identityChainId: z.literal(97),
    dataChainId: z.literal(56),
    paymentChainId: z.literal(97),
    executionChainId: z.null(),
    requester: address,
    analysisAuthorized: z.boolean(),
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
    maxSnapshotAgeSeconds: z.number().int().min(1).max(300),
    snapshot: z
      .object({
        schemaVersion: z.literal("knot.yield.snapshot/2"),
        snapshotId: z.string().min(1),
        chainId: z.literal(56),
        blockNumber: positiveBaseUnits,
        blockHash: digest,
        blockTimestampUtc: utc,
        capturedAtUtc: utc,
        canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
        sources: z.array(source).min(1),
        asset,
        costValuation,
        markets: z.array(marketSnapshot).min(2),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedProtocols).size !== value.allowedProtocols.length) {
      context.addIssue({ code: "custom", path: ["allowedProtocols"], message: "protocols must be unique" });
    }
    const marketIds = value.snapshot.markets.map((market) => market.marketId);
    if (new Set(marketIds).size !== marketIds.length) {
      context.addIssue({ code: "custom", path: ["snapshot", "markets"], message: "market IDs must be unique" });
    }
  });

const comparison = z
  .object({
    marketId: z.string().min(1),
    protocol,
    integrationId,
    rateBasis: z.enum(["per_second", "per_block"]),
    baseRateSourceUri: z.string().min(1),
    baseAnnualRateRay: baseUnits,
    incentiveStatus: z.enum(["none", "valued"]),
    incentiveValuationSourceUri: z.string().min(1).nullable(),
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
  .strict();
const evidence = z
  .object({
    snapshotId: z.string().min(1),
    chainId: z.literal(56),
    blockNumber: positiveBaseUnits,
    blockHash: digest,
    blockTimestampUtc: utc,
    capturedAtUtc: utc,
    sources: z.array(z.string().min(1)).min(1),
  })
  .strict();

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
    reasonCode: z
      .enum([
        "ANALYSIS_ONLY",
        "AUTHORITY_MISMATCH",
        "BELOW_MINIMUM_IMPROVEMENT",
        "COSTS_DOMINATE",
        "COST_VALUATION_UNKNOWN",
        "CURRENT_MARKET_DATA_INCOMPLETE",
        "CURRENT_MARKET_NOT_FOUND",
        "CURRENT_MARKET_UNSUPPORTED",
        "INVALID_JSON",
        "NO_ELIGIBLE_ALTERNATIVE",
        "SCHEMA_VALIDATION_FAILED",
        "SNAPSHOT_TARGET_MISMATCH",
        "STALE_COST_VALUATION",
        "STALE_SNAPSHOT",
      ])
      .nullable(),
    assessedAtUtc: utc,
    evidence: evidence.nullable(),
    currentMarketId: z.string().nullable(),
    selectedMarketId: z.string().nullable(),
    eligibleMarkets: z.array(comparison),
    excludedMarkets: z
      .array(z.object({ marketId: z.string(), reasons: z.array(z.string().min(1)).min(1) }).strict()),
    recommendation: z.enum(["HOLD", "MIGRATE", "REFUSED"]),
    recommendationReason: z.string().min(1),
    assumptions: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export type YieldScoutRequest = z.infer<typeof yieldScoutRequest>;
export type YieldScoutArtifact = z.infer<typeof yieldScoutArtifact>;
export type YieldMarketSnapshot = YieldScoutRequest["snapshot"]["markets"][number];
