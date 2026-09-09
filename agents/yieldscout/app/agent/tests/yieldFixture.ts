import { yieldScoutRequest, type YieldScoutRequest } from "../src/yieldSchemas.js";

export const NOW = new Date("2026-09-09T12:00:00.000Z");
const RAY = 10n ** 27n;
const YEAR_SECONDS = 31_536_000n;
const HASH = `0x${"a".repeat(64)}`;
const REQUESTER = "0x1111111111111111111111111111111111111111";

function ratePerPeriod(percent: bigint, periodsPerYear: bigint): string {
  return ((RAY * percent) / 100n / periodsPerYear).toString();
}

export function yieldFixture(): YieldScoutRequest {
  const asset = {
    chainId: 56 as const,
    address: "0x2222222222222222222222222222222222222222",
    symbol: "USDC",
    decimals: 6,
    mechanics: "plain_erc20" as const,
  };
  const source = { uri: "bsc://block/60000000", contentHash: HASH, method: "eth_call at block hash" };
  return yieldScoutRequest.parse({
    schemaVersion: "knot.yield.request/2",
    taskId: "yield-task-1",
    category: "yield",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    requester: REQUESTER,
    analysisAuthorized: true,
    asset,
    amountUnits: "1000000000",
    holdingHorizonSeconds: 31_536_000,
    allowedProtocols: ["venus", "aave-v3"],
    currentMarketId: "venus-usdc",
    withdrawalNeedsUnits: "500000000",
    minimumLiquidityUnits: "1000000000",
    concentrationCapBps: 6_000,
    gasAllowanceUnits: "1000000",
    minimumImprovementUnits: "1000000",
    noLpExposure: true,
    maxSnapshotAgeSeconds: 300,
    snapshot: {
      schemaVersion: "knot.yield.snapshot/2",
      snapshotId: "yield-snapshot-1",
      chainId: 56,
      blockNumber: "60000000",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T11:59:20.000Z",
      capturedAtUtc: "2026-09-09T11:59:30.000Z",
      canonicality: "confirmed",
      sources: [source],
      asset,
      costValuation: {
        status: "current",
        asset,
        observedAtUtc: "2026-09-09T11:59:30.000Z",
        source,
      },
      markets: [
        {
          marketId: "venus-usdc",
          integrationId: "venus-core-supply-v1",
          protocol: "venus",
          marketAddress: "0x3333333333333333333333333333333333333333",
          asset,
          dataStatus: "current",
          observedAtUtc: "2026-09-09T11:59:30.000Z",
          dataSource: source,
          periodBasis: { kind: "per_second", periodsPerYear: "31536000", source },
          baseRatePerPeriodRay: ratePerPeriod(4n, YEAR_SECONDS),
          incentiveRate: { status: "none" },
          availableLiquidityUnits: "50000000000",
          capacity: { kind: "uncapped", supplyCapUnits: null },
          totalSuppliedUnits: "100000000000",
          supplyState: "active",
          withdrawalState: "active",
          exposure: "same_asset",
          leverage: false,
          concentrationBps: 2_000,
          entryCostUnits: "10000",
          exitCostUnits: "10000",
          riskFlags: [],
          uncertainty: ["rate can change after the pinned block"],
        },
        {
          marketId: "aave-usdc",
          integrationId: "aave-v3-bsc-supply-v1",
          protocol: "aave-v3",
          marketAddress: "0x4444444444444444444444444444444444444444",
          asset,
          dataStatus: "current",
          observedAtUtc: "2026-09-09T11:59:30.000Z",
          dataSource: source,
          periodBasis: { kind: "per_block", periodsPerYear: "15768000", source },
          baseRatePerPeriodRay: ratePerPeriod(8n, 15_768_000n),
          incentiveRate: {
            status: "valued",
            ratePerPeriodRay: ratePerPeriod(1n, 15_768_000n),
            observedAtUtc: "2026-09-09T11:59:30.000Z",
            valuationSource: source,
          },
          availableLiquidityUnits: "70000000000",
          capacity: { kind: "capped", supplyCapUnits: "200000000000" },
          totalSuppliedUnits: "120000000000",
          supplyState: "active",
          withdrawalState: "active",
          exposure: "same_asset",
          leverage: false,
          concentrationBps: 3_000,
          entryCostUnits: "10000",
          exitCostUnits: "10000",
          riskFlags: [],
          uncertainty: ["incentive valuation can change"],
        },
      ],
    },
  });
}
