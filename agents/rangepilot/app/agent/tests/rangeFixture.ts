import { rangePilotRequest, type RangePilotRequest } from "../src/rangeSchemas.js";
import { sqrtRatioAtTick } from "../src/rangeMath.js";

export const NOW = new Date("2026-09-09T10:00:10.000Z");
const MANAGER = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const FACTORY = "0x4444444444444444444444444444444444444444";
const TOKEN0 = "0x5555555555555555555555555555555555555555";
const TOKEN1 = "0x6666666666666666666666666666666666666666";
const HASH = `0x${"a".repeat(64)}`;
const LARGE = "1000000000000000000000000000000000000";

export function rangeFixture(): RangePilotRequest {
  return rangePilotRequest.parse({
    schemaVersion: "knot.rangepilot.request/1",
    task: {
      schemaVersion: "knot.rangepilot.task/1",
      taskId: "range-1",
      category: "rebalancing",
      capability: "analysis",
      chainId: 56,
      positionManager: MANAGER,
      positionTokenId: "42",
      controllingAccount: OWNER,
      allowedPool: {
        address: POOL,
        factory: FACTORY,
        token0: { address: TOKEN0, symbol: "USDC", decimals: 6, mechanics: "plain_erc20" },
        token1: { address: TOKEN1, symbol: "WBNB", decimals: 18, mechanics: "plain_erc20" },
        feeTier: 2500,
        tickSpacing: 50,
        minimumTick: -887250,
        maximumTick: 887250,
        maximumSlippageBps: 100,
      },
      constraints: {
        token0BudgetUnits: LARGE,
        token1BudgetUnits: LARGE,
        minimumRangeWidthTicks: 100,
        targetRangeWidthTicks: 200,
        maximumRangeWidthTicks: 300,
        maximumSlippageBps: 50,
        gasBudgetWei: "500000000000000",
        cooldownSeconds: 300,
        executionMode: "analysis",
      },
      snapshotId: "range-snapshot-1",
    },
    snapshot: {
      schemaVersion: "knot.rangepilot.snapshot/1",
      snapshotId: "range-snapshot-1",
      chainId: 56,
      blockNumber: "12345678",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:05.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://block/12345678", contentHash: HASH, method: "eth_call at block hash" }],
      positionManager: MANAGER,
      positionTokenId: "42",
      position: {
        owner: OWNER,
        pool: POOL,
        token0: TOKEN0,
        token1: TOKEN1,
        feeTier: 2500,
        tickLower: -100,
        tickUpper: 100,
        liquidity: "1000000000000000000",
        feeGrowthInside0LastX128: "12",
        feeGrowthInside1LastX128: "15",
        tokensOwed0: "1000000",
        tokensOwed1: "2000000000000000",
        farmed: false,
      },
      pool: {
        protocol: "pancakeswap-v3",
        address: POOL,
        factory: FACTORY,
        token0: { address: TOKEN0, symbol: "USDC", decimals: 6, mechanics: "plain_erc20", balanceUnits: LARGE },
        token1: { address: TOKEN1, symbol: "WBNB", decimals: 18, mechanics: "plain_erc20", balanceUnits: LARGE },
        feeTier: 2500,
        tickSpacing: 50,
        currentTick: 0,
        sqrtPriceX96: sqrtRatioAtTick(0).toString(),
        activeLiquidity: "5000000000000000000",
        initialized: true,
        hasHooks: false,
      },
      account: { address: OWNER, canManagePosition: true },
      lastCompletedActionAtUtc: null,
      gasEstimate: {
        gasUnits: "300000",
        gasPriceWei: "1000000000",
        estimatedAtUtc: "2026-09-09T10:00:06.000Z",
        method: "eth_estimateGas against pinned state",
      },
    },
    maxSnapshotAgeSeconds: 15,
  });
}
