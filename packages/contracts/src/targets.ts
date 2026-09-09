import { z } from "zod"
import { address, baseUnits, chainId } from "./primitives.ts"

const bps = z.number().int().min(0).max(10_000)
const positiveSeconds = z.number().int().positive()

const health = z
  .object({
    category: z.literal("health"),
    target: z
      .object({
        borrower: address,
        comptroller: address,
        poolFamily: z.enum(["venus-core", "venus-isolated"]),
      })
      .strict(),
    constraints: z
      .object({
        safetyThresholdRatio: z.number().gt(1).max(100),
        actionThresholdRatio: z.number().gt(1).max(100),
        repaymentAsset: address,
        maxRepaymentUnits: baseUnits,
        gasBudgetWei: baseUnits,
        pollIntervalSeconds: positiveSeconds,
        mode: z.enum(["notify", "execute"]),
      })
      .strict()
      .refine((c) => c.actionThresholdRatio <= c.safetyThresholdRatio, {
        message: "actionThresholdRatio must not exceed safetyThresholdRatio",
      }),
  })
  .strict()

const rebalancing = z
  .object({
    category: z.literal("rebalancing"),
    target: z
      .object({
        positionManager: address,
        positionTokenId: baseUnits,
        controllingAccount: address,
        pool: address,
      })
      .strict(),
    constraints: z
      .object({
        tokenBudgetUnits: baseUnits,
        rangeWidthBps: bps,
        slippageBps: bps,
        cooldownSeconds: positiveSeconds,
        mode: z.enum(["analysis", "execute"]),
      })
      .strict(),
  })
  .strict()

const grid = z
  .object({
    category: z.literal("grid"),
    target: z.object({ baseToken: address, quoteToken: address, pool: address }).strict(),
    constraints: z
      .object({
        lowerPriceUnits: baseUnits,
        upperPriceUnits: baseUnits,
        gridCount: z.number().int().min(2).max(100),
        spacing: z.enum(["arithmetic", "geometric"]),
        principalUnits: baseUnits,
        orderSizeFloorUnits: baseUnits,
        maxInventoryExposureUnits: baseUnits,
        slippageBps: bps,
        cooldownSeconds: positiveSeconds,
        expiryUtc: z.iso.datetime(),
        mode: z.enum(["analysis", "execute"]),
      })
      .strict(),
  })
  .strict()

const yieldRouting = z
  .object({
    category: z.literal("yield"),
    target: z.object({ asset: address, amountUnits: baseUnits }).strict(),
    constraints: z
      .object({
        horizonSeconds: positiveSeconds,
        allowedProtocols: z.array(z.string().min(1)).min(1),
        allowLpExposure: z.boolean(),
        minMarketLiquidityUnits: baseUnits,
        concentrationCapBps: bps,
        gasAllowanceWei: baseUnits,
        minImprovementBps: bps,
        mode: z.enum(["analysis", "execute"]),
      })
      .strict(),
  })
  .strict()

const security = z
  .object({
    category: z.literal("security"),
    target: z
      .object({ contractAddress: address, contractChainId: chainId, includeImplementation: z.boolean() })
      .strict(),
    constraints: z
      .object({
        scope: z.array(z.enum(["access-control", "proxy", "token-behavior", "external-calls"])).min(1),
        maxFindings: z.number().int().min(1).max(200),
      })
      .strict(),
  })
  .strict()

export const categoryPayload = z.discriminatedUnion("category", [
  health,
  rebalancing,
  grid,
  yieldRouting,
  security,
])

export type CategoryPayload = z.infer<typeof categoryPayload>
export type HealthPayload = z.infer<typeof health>
export type RebalancingPayload = z.infer<typeof rebalancing>
export type GridPayload = z.infer<typeof grid>
export type YieldPayload = z.infer<typeof yieldRouting>
export type SecurityPayload = z.infer<typeof security>
