import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const digest = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());
const utc = z.string().datetime({ offset: true });
const chainId = z.union([z.literal(56), z.literal(97)]);
const amount = z
  .object({ chainId, token: address, units: baseUnits, decimals: z.number().int().min(0).max(36) })
  .strict();

export const healthTask = z
  .object({
    schemaVersion: z.literal("knot.task/1"),
    taskId: z.string().min(1),
    category: z.literal("health"),
    capability: z.enum(["analysis", "monitoring", "execution"]),
    identityChainId: chainId,
    dataChainId: chainId,
    paymentChainId: chainId,
    executionChainId: chainId.nullable(),
    target: z
      .object({
        borrower: address,
        comptroller: address,
        poolFamily: z.enum(["venus-core", "venus-isolated"]),
      })
      .strict(),
    constraints: z
      .object({
        safetyThresholdRatio: z.number().finite().gt(1).max(100),
        actionThresholdRatio: z.number().finite().gt(1).max(100),
        repaymentAsset: address,
        maxRepaymentUnits: baseUnits,
        gasBudgetWei: baseUnits,
        pollIntervalSeconds: z.number().int().positive(),
        mode: z.enum(["notify", "execute"]),
      })
      .strict(),
    serviceFeeLimit: amount,
    managedPrincipal: z.array(amount),
    executionSpendLimits: z.array(amount),
    deadlineUtc: utc,
    inputHash: digest,
    snapshotId: z.string().min(1),
  })
  .strict()
  .refine((value) => value.constraints.actionThresholdRatio <= value.constraints.safetyThresholdRatio, {
    message: "actionThresholdRatio must not exceed safetyThresholdRatio",
  })
  .refine((value) => value.executionChainId === null || value.executionChainId === value.dataChainId, {
    message: "executionChainId must match dataChainId",
  })
  .refine((value) => value.capability === "execution" || value.executionSpendLimits.length === 0, {
    message: "only execution tasks may carry execution spend limits",
  });

const source = z
  .object({ uri: z.string().min(1), contentHash: digest, method: z.string().min(1) })
  .strict();

const market = z
  .object({
    asset: address,
    symbol: z.string().min(1).max(32),
    decimals: z.number().int().min(0).max(36),
    collateralUnits: baseUnits,
    debtUnits: baseUnits,
    oraclePriceUsdE18: baseUnits.nullable(),
    collateralFactorBps: z.number().int().min(0).max(10_000),
    liquidationThresholdBps: z.number().int().min(0).max(10_000),
    collateralEnabled: z.boolean(),
    oracleStatus: z.enum(["current", "unavailable"]),
    priceObservedAtUtc: utc.nullable(),
    supported: z.boolean(),
  })
  .strict();

const specialDebt = z
  .object({ kind: z.string().min(1), valueUsdE18: baseUnits.nullable(), supported: z.boolean() })
  .strict();

export const healthSnapshot = z
  .object({
    schemaVersion: z.literal("knot.health.snapshot/1"),
    snapshotId: z.string().min(1),
    chainId,
    blockNumber: baseUnits,
    blockHash: digest,
    blockTimestampUtc: utc,
    capturedAtUtc: utc,
    canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
    sources: z.array(source).min(1),
    borrower: address,
    comptroller: address,
    poolFamily: z.enum(["venus-core", "venus-isolated"]),
    debtInventoryComplete: z.boolean(),
    protocolStatus: z.enum(["active", "paused", "unknown"]),
    forcedLiquidation: z.enum(["enabled", "paused", "unknown"]),
    actionAvailable: z.boolean(),
    markets: z.array(market),
    specialDebts: z.array(specialDebt),
  })
  .strict();

export const healthGuardRequest = z
  .object({
    schemaVersion: z.literal("knot.health.request/1"),
    task: healthTask,
    snapshot: healthSnapshot,
    maxSnapshotAgeSeconds: z.number().int().positive().max(300).default(15),
  })
  .strict();

export type HealthGuardRequest = z.infer<typeof healthGuardRequest>;
export type HealthMarket = HealthGuardRequest["snapshot"]["markets"][number];
