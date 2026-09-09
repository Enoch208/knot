import { GRIDQUANT_PAIR } from "../src/gridQuant.js";
import { gridQuantRequest, type GridQuantRequest } from "../src/gridSchemas.js";

export const NOW = new Date("2026-09-09T10:00:10.000Z");
const REQUESTER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"a".repeat(64)}`;

export function gridFixture(): GridQuantRequest {
  const pair = {
    chainId: 56 as const,
    baseToken: {
      address: GRIDQUANT_PAIR.baseToken,
      symbol: GRIDQUANT_PAIR.baseSymbol,
      decimals: GRIDQUANT_PAIR.baseDecimals,
      mechanics: "plain_erc20" as const,
    },
    quoteToken: {
      address: GRIDQUANT_PAIR.quoteToken,
      symbol: GRIDQUANT_PAIR.quoteSymbol,
      decimals: GRIDQUANT_PAIR.quoteDecimals,
      mechanics: "plain_erc20" as const,
    },
    pool: GRIDQUANT_PAIR.pool,
  };
  return gridQuantRequest.parse({
    schemaVersion: "knot.gridquant.request/2",
    task: {
      schemaVersion: "knot.gridquant.task/1",
      taskId: "grid-1",
      category: "grid",
      capability: "analysis",
      identityChainId: 97,
      dataChainId: 56,
      paymentChainId: 97,
      executionChainId: null,
      requester: REQUESTER,
      pair,
      parameters: {
        lowerPriceUnits: "50000",
        upperPriceUnits: "80000",
        priceDecimals: 2,
        gridCount: 4,
        spacing: "arithmetic",
        principalQuoteUnits: "1000000000000000000000",
        orderSizeFloorQuoteUnits: "100000000000000000000",
        maxBaseInventoryUnits: "3000000000000000000",
        feeAssumptions: { buyFeeBps: 25, sellFeeBps: 25 },
        slippageBps: 10,
        cooldownSeconds: 300,
        expiryUtc: "2026-09-10T00:00:00.000Z",
        executionMode: "analysis",
      },
      snapshotId: "grid-snapshot-1",
    },
    snapshot: {
      schemaVersion: "knot.gridquant.snapshot/1",
      snapshotId: "grid-snapshot-1",
      chainId: 56,
      blockNumber: "120852687",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:05.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://block/120852687", contentHash: HASH, method: "eth_call at block hash" }],
      requester: REQUESTER,
      analysisAuthorized: true,
      pair,
      lastActionUtc: null,
      gasEstimate: {
        gasUnits: "300000",
        gasPriceWei: "1000000000",
        nativeTokenPriceQuoteUnits: "600000000000000000000",
        estimatedNetworkFeeQuoteUnitsPerSwap: "180000000000000000",
        estimatedAtUtc: "2026-09-09T10:00:06.000Z",
        method: "eth_estimateGas and pinned quote conversion",
      },
    },
    maxSnapshotAgeSeconds: 15,
  });
}
