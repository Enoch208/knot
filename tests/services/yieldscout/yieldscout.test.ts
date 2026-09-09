import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  analyzeYieldScout,
  analyzeYieldScoutText,
  supportedYieldIntegrations,
  yieldScoutArtifact,
  yieldScoutRequest,
  type YieldScoutRequest,
} from "../../../packages/services/yieldscout/index.ts"

const NOW = new Date("2026-09-09T12:00:00.000Z")
const RAY = 10n ** 27n
const YEAR_SECONDS = 31_536_000n

function ratePerPeriod(percent: bigint, periodsPerYear: bigint): string {
  return ((RAY * percent) / 100n / periodsPerYear).toString()
}

function validRequest(): YieldScoutRequest {
  const asset = {
    chainId: 56 as const,
    address: "0x1111111111111111111111111111111111111111",
    symbol: "USDC",
    decimals: 6,
  }
  return yieldScoutRequest.parse({
    schemaVersion: "knot.yield.request/1",
    taskId: "yield-task-1",
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
      schemaVersion: "knot.yield.snapshot/1",
      snapshotId: "yield-snapshot-1",
      chainId: 56,
      blockNumber: "60000000",
      blockHash: `0x${"a".repeat(64)}`,
      capturedAtUtc: "2026-09-09T11:59:30.000Z",
      canonicality: "confirmed",
      asset,
      costValuation: {
        status: "current",
        asset,
        observedAtUtc: "2026-09-09T11:59:30.000Z",
        source: "gas quote converted to USDC at the pinned block",
      },
      markets: [
        {
          marketId: "venus-usdc",
          integrationId: "venus-core-supply-v1",
          protocol: "venus",
          marketAddress: "0x2222222222222222222222222222222222222222",
          asset,
          dataStatus: "current",
          observedAtUtc: "2026-09-09T11:59:30.000Z",
          periodBasis: {
            kind: "per_second",
            periodsPerYear: "31536000",
            source: "market rate model reports a per-second rate",
          },
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
          uncertainty: ["rate can change after the pinned block"],
        },
        {
          marketId: "aave-usdc",
          integrationId: "aave-v3-bsc-supply-v1",
          protocol: "aave-v3",
          marketAddress: "0x3333333333333333333333333333333333333333",
          asset,
          dataStatus: "current",
          observedAtUtc: "2026-09-09T11:59:30.000Z",
          periodBasis: {
            kind: "per_block",
            periodsPerYear: "15768000",
            source: "observed BSC block cadence at the pinned snapshot",
          },
          baseRatePerPeriodRay: ratePerPeriod(8n, 15_768_000n),
          incentiveRate: {
            status: "valued",
            ratePerPeriodRay: ratePerPeriod(1n, 15_768_000n),
            valuationSource: "pinned incentive-token quote denominated in USDC",
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
          uncertainty: ["incentive valuation can change"],
        },
      ],
    },
  })
}

function destination(request: YieldScoutRequest) {
  const market = request.snapshot.markets.find((candidate) => candidate.marketId === "aave-usdc")
  assert.ok(market)
  return market
}

describe("YieldScout deterministic analysis", () => {
  test("declares two BSC same-asset no-leverage integration profiles", () => {
    assert.deepEqual(Object.keys(supportedYieldIntegrations).sort(), ["aave-v3-bsc-supply-v1", "venus-core-supply-v1"])
    for (const integration of Object.values(supportedYieldIntegrations)) {
      assert.equal(integration.chainId, 56)
      assert.equal(integration.exposure, "same_asset")
      assert.equal(integration.leverage, false)
      assert.ok(integration.depositSemantics.length > 0)
      assert.ok(integration.withdrawalSemantics.length > 0)
    }
  })

  test("normalizes explicit per-second and per-block bases and recommends a threshold-clearing migration", () => {
    const result = analyzeYieldScout(validRequest(), NOW)
    assert.equal(result.status, "ASSESSED")
    assert.equal(result.recommendation, "MIGRATE")
    assert.equal(result.selectedMarketId, "aave-usdc")
    assert.equal(result.eligibleMarkets.length, 2)
    const current = result.eligibleMarkets.find((market) => market.marketId === "venus-usdc")
    const selected = result.eligibleMarkets.find((market) => market.marketId === "aave-usdc")
    assert.ok(current)
    assert.ok(selected)
    assert.equal(current.entryCostUnits, "0")
    assert.equal(selected.sourceExitCostUnits, "10000")
    assert.ok(BigInt(selected.baseAnnualRateRay) > BigInt(current.baseAnnualRateRay))
    assert.ok(BigInt(selected.horizonIncentiveBenefitUnits) > 0n)
    assert.ok(BigInt(selected.improvementVsHoldUnits) >= 1_000_000n)
    assert.equal(yieldScoutArtifact.safeParse(result).success, true)
  })

  test("holds when migration costs dominate over the horizon", () => {
    const request = validRequest()
    destination(request).entryCostUnits = "60000000"
    destination(request).exitCostUnits = "60000000"
    request.gasAllowanceUnits = "150000000"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ACTION")
    assert.equal(result.reasonCode, "COSTS_DOMINATE")
    assert.equal(result.recommendation, "HOLD")
    assert.equal(result.selectedMarketId, "venus-usdc")
  })

  test("holds when positive benefit does not clear the requested improvement threshold", () => {
    const request = validRequest()
    request.minimumImprovementUnits = "100000000"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ACTION")
    assert.equal(result.reasonCode, "BELOW_MINIMUM_IMPROVEMENT")
    assert.equal(result.recommendation, "HOLD")
  })

  test("returns no alternative with every unsafe destination reason disclosed", () => {
    const request = validRequest()
    const market = destination(request)
    market.exposure = "lp"
    market.leverage = true
    market.supplyState = "paused"
    market.withdrawalState = "unknown"
    market.availableLiquidityUnits = "1"
    market.capacity = { kind: "capped", supplyCapUnits: market.totalSuppliedUnits }
    market.concentrationBps = 8_000
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ALTERNATIVE")
    assert.equal(result.recommendation, "HOLD")
    const reasons = result.excludedMarkets[0]?.reasons.join(" ") ?? ""
    assert.match(reasons, /LP exposure/)
    assert.match(reasons, /leveraged/)
    assert.match(reasons, /supply state is paused/)
    assert.match(reasons, /withdrawal state is unknown/)
    assert.match(reasons, /liquidity/)
    assert.match(reasons, /capacity/)
    assert.match(reasons, /concentration/)
  })

  test("excludes destinations with an unknown incentive valuation", () => {
    const request = validRequest()
    destination(request).incentiveRate = { status: "unknown" }
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ALTERNATIVE")
    assert.match(result.excludedMarkets[0]?.reasons.join(" ") ?? "", /incentive valuation is unknown/)
  })

  test("fails closed when the pinned snapshot is stale", () => {
    const request = validRequest()
    request.snapshot.capturedAtUtc = "2026-09-09T11:00:00.000Z"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "STALE_SNAPSHOT")
    assert.equal(result.recommendation, "REFUSED")
    assert.equal(result.eligibleMarkets.length, 0)
  })

  test("fails closed when current-market data is unknown", () => {
    const request = validRequest()
    request.snapshot.markets[0]!.dataStatus = "unknown"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "ASSESSMENT_INCOMPLETE")
    assert.equal(result.reasonCode, "CURRENT_MARKET_DATA_INCOMPLETE")
    assert.equal(result.recommendation, "REFUSED")
  })

  test("refuses an LP or leveraged current position instead of calling it eligible", () => {
    const request = validRequest()
    request.snapshot.markets[0]!.exposure = "lp"
    request.snapshot.markets[0]!.leverage = true
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "UNSUPPORTED_POSITION")
    assert.equal(result.reasonCode, "CURRENT_MARKET_UNSUPPORTED")
    assert.equal(result.recommendation, "REFUSED")
    assert.equal(result.eligibleMarkets.length, 0)
  })

  test("fails closed when gas-cost valuation is unknown", () => {
    const request = validRequest()
    request.snapshot.costValuation = {
      status: "unknown",
      asset: request.asset,
      observedAtUtc: null,
      source: null,
    }
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "ASSESSMENT_INCOMPLETE")
    assert.equal(result.reasonCode, "COST_VALUATION_UNKNOWN")
  })

  test("rejects a destination whose explicit integration does not match its protocol", () => {
    const request = validRequest()
    destination(request).protocol = "venus"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ALTERNATIVE")
    assert.match(result.excludedMarkets[0]?.reasons.join(" ") ?? "", /integration and protocol do not match/)
  })

  test("does not compare a different asset", () => {
    const request = validRequest()
    destination(request).asset.address = "0x4444444444444444444444444444444444444444"
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "NO_ALTERNATIVE")
    assert.match(result.excludedMarkets[0]?.reasons.join(" ") ?? "", /not the requested asset/)
  })

  test("uses bigint arithmetic for principal beyond Number safe precision", () => {
    const request = validRequest()
    request.amountUnits = "900719925474099312345678901234567890"
    request.snapshot.markets[0]!.availableLiquidityUnits = request.amountUnits
    destination(request).availableLiquidityUnits = request.amountUnits
    destination(request).capacity = { kind: "uncapped", supplyCapUnits: null }
    const result = analyzeYieldScout(request, NOW)
    assert.equal(result.status, "ASSESSED")
    const selected = result.eligibleMarkets.find((market) => market.marketId === "aave-usdc")
    assert.ok(selected)
    assert.ok(BigInt(selected.horizonBaseBenefitUnits) > BigInt(Number.MAX_SAFE_INTEGER))
  })
})

describe("YieldScout closed request boundary", () => {
  test("rejects unknown fields and duplicate market IDs", () => {
    const extra = { ...validRequest(), unexpected: true }
    assert.equal(yieldScoutRequest.safeParse(extra).success, false)
    const duplicate = validRequest()
    duplicate.snapshot.markets[1]!.marketId = duplicate.snapshot.markets[0]!.marketId
    assert.equal(yieldScoutRequest.safeParse(duplicate).success, false)
  })

  test("returns typed invalid-request artifacts for invalid JSON and invalid schemas", () => {
    const invalidJson = JSON.parse(analyzeYieldScoutText("{", NOW))
    const invalidSchema = JSON.parse(analyzeYieldScoutText(JSON.stringify({ schemaVersion: "wrong" }), NOW))
    assert.equal(invalidJson.status, "INVALID_REQUEST")
    assert.equal(invalidJson.reasonCode, "INVALID_JSON")
    assert.equal(invalidSchema.status, "INVALID_REQUEST")
    assert.equal(invalidSchema.reasonCode, "SCHEMA_VALIDATION_FAILED")
    assert.equal(yieldScoutArtifact.safeParse(invalidJson).success, true)
    assert.equal(yieldScoutArtifact.safeParse(invalidSchema).success, true)
  })
})
