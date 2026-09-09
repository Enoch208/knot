import { healthGuardRequest, type HealthGuardRequest } from "../src/healthSchemas.js";

export const NOW = new Date("2026-09-09T10:00:10.000Z");
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ONE_HASH = `0x${"1".repeat(64)}`;

export function healthFixture(): HealthGuardRequest {
  return healthGuardRequest.parse({
    schemaVersion: "knot.health.request/1",
    maxSnapshotAgeSeconds: 15,
    task: {
      schemaVersion: "knot.task/1",
      taskId: "health-1",
      category: "health",
      capability: "analysis",
      identityChainId: 97,
      dataChainId: 56,
      paymentChainId: 97,
      executionChainId: null,
      target: { borrower: A, comptroller: B, poolFamily: "venus-core" },
      constraints: {
        safetyThresholdRatio: 1.5,
        actionThresholdRatio: 1.4,
        repaymentAsset: C,
        maxRepaymentUnits: "50000000000000000000",
        gasBudgetWei: "0",
        pollIntervalSeconds: 60,
        mode: "notify",
      },
      serviceFeeLimit: { chainId: 97, token: C, units: "100000000000000000", decimals: 18 },
      managedPrincipal: [],
      executionSpendLimits: [],
      deadlineUtc: "2026-09-09T11:00:00.000Z",
      inputHash: ZERO_HASH,
      snapshotId: "snapshot-1",
    },
    snapshot: {
      schemaVersion: "knot.health.snapshot/1",
      snapshotId: "snapshot-1",
      chainId: 56,
      blockNumber: "65000000",
      blockHash: ONE_HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:00.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://venus/core", contentHash: ZERO_HASH, method: "eth_call@blockHash" }],
      borrower: A,
      comptroller: B,
      poolFamily: "venus-core",
      debtInventoryComplete: true,
      protocolStatus: "active",
      forcedLiquidation: "enabled",
      actionAvailable: true,
      markets: [
        {
          asset: A,
          symbol: "COL",
          decimals: 18,
          collateralUnits: "100000000000000000000",
          debtUnits: "0",
          oraclePriceUsdE18: "2000000000000000000",
          collateralFactorBps: 7500,
          liquidationThresholdBps: 8000,
          collateralEnabled: true,
          oracleStatus: "current",
          priceObservedAtUtc: "2026-09-09T10:00:00.000Z",
          supported: true,
        },
        {
          asset: C,
          symbol: "DEBT",
          decimals: 18,
          collateralUnits: "0",
          debtUnits: "100000000000000000000",
          oraclePriceUsdE18: "1000000000000000000",
          collateralFactorBps: 0,
          liquidationThresholdBps: 0,
          collateralEnabled: false,
          oracleStatus: "current",
          priceObservedAtUtc: "2026-09-09T10:00:00.000Z",
          supported: true,
        },
      ],
      specialDebts: [],
    },
  });
}
