import type { YieldComparison, YieldEvaluationMarket, YieldScoutEvaluationInput } from "./yieldscout-schemas.ts"

const RAY = 10n ** 27n
const YEAR_SECONDS = 31_536_000n
const integrations = {
  "venus-core-supply-v1": { chainId: 56, protocol: "venus" },
  "aave-v3-bsc-supply-v1": { chainId: 56, protocol: "aave-v3" },
} as const

export interface YieldExpectedResult {
  status: "ASSESSED" | "NO_ACTION" | "NO_ALTERNATIVE" | "STALE_SNAPSHOT" | "ASSESSMENT_INCOMPLETE" | "UNSUPPORTED_POSITION"
  reasonCode: "ANALYSIS_ONLY" | "AUTHORITY_MISMATCH" | "BELOW_MINIMUM_IMPROVEMENT" | "COSTS_DOMINATE" | "COST_VALUATION_UNKNOWN" | "CURRENT_MARKET_DATA_INCOMPLETE" | "CURRENT_MARKET_NOT_FOUND" | "CURRENT_MARKET_UNSUPPORTED" | "NO_ELIGIBLE_ALTERNATIVE" | "SNAPSHOT_TARGET_MISMATCH" | "STALE_COST_VALUATION" | "STALE_SNAPSHOT" | null
  eligibleMarkets: YieldComparison[]
  excludedMarkets: Array<{ marketId: string; reasons: string[] }>
  recommendation: "HOLD" | "MIGRATE" | "REFUSED"
  selectedMarketId: string | null
}

export function deriveYieldExpected(input: YieldScoutEvaluationInput, now: Date): YieldExpectedResult {
  if (input.capability !== "analysis" || input.executionChainId !== null) return refused(input, "UNSUPPORTED_POSITION", "ANALYSIS_ONLY", ["YieldScout produces analysis only"])
  if (!input.analysisAuthorized) return refused(input, "UNSUPPORTED_POSITION", "AUTHORITY_MISMATCH", ["requester did not authorize this analysis"])
  const mismatches = snapshotMismatches(input)
  if (mismatches.length > 0) return refused(input, "ASSESSMENT_INCOMPLETE", "SNAPSHOT_TARGET_MISMATCH", mismatches)
  if (!snapshotFresh(input, now)) return refused(input, "STALE_SNAPSHOT", "STALE_SNAPSHOT", ["snapshot is not confirmed and current"])
  if (input.snapshot.costValuation.status !== "current") return refused(input, "ASSESSMENT_INCOMPLETE", "COST_VALUATION_UNKNOWN", ["migration cost valuation is unknown"])
  if (stale(input.snapshot.costValuation.observedAtUtc, input, now)) return refused(input, "STALE_SNAPSHOT", "STALE_COST_VALUATION", ["migration cost valuation is stale"])
  const current = input.snapshot.markets.find((market) => market.marketId === input.currentMarketId)
  if (!current) return refused(input, "UNSUPPORTED_POSITION", "CURRENT_MARKET_NOT_FOUND", ["current market is absent"])
  const failures = marketFailures(current, input, now)
  const incomplete = failures.filter((reason) => reason.includes("unknown") || reason.includes("stale") || reason.includes("source"))
  if (incomplete.length > 0) return refused(input, "ASSESSMENT_INCOMPLETE", "CURRENT_MARKET_DATA_INCOMPLETE", incomplete)
  if (failures.length > 0) return refused(input, "UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", failures)
  if (current.withdrawalState !== "active") return refused(input, "UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", [`withdrawal state is ${current.withdrawalState}`])
  if (current.availableLiquidityUnits === null) return refused(input, "ASSESSMENT_INCOMPLETE", "CURRENT_MARKET_DATA_INCOMPLETE", ["withdrawal liquidity is unknown"])
  if (BigInt(current.availableLiquidityUnits) < BigInt(input.amountUnits)) return refused(input, "UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", ["source withdrawal liquidity is insufficient"])
  if (BigInt(current.exitCostUnits) > BigInt(input.gasAllowanceUnits)) return refused(input, "UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", ["source exit cost exceeds gas allowance"])
  const hold = project(current, input, 0n, true, 0n)
  const eligibleMarkets = [hold]
  const excludedMarkets: Array<{ marketId: string; reasons: string[] }> = []
  for (const market of input.snapshot.markets) {
    if (market.marketId === current.marketId) continue
    const reasons = destinationFailures(market, input, now)
    if (BigInt(current.exitCostUnits) + BigInt(market.entryCostUnits) + BigInt(market.exitCostUnits) > BigInt(input.gasAllowanceUnits)) reasons.push("migration costs exceed gas allowance")
    if (reasons.length > 0) excludedMarkets.push({ marketId: market.marketId, reasons: [...new Set(reasons)] })
    else eligibleMarkets.push(project(market, input, BigInt(current.exitCostUnits), false, BigInt(hold.netBenefitUnits)))
  }
  if (eligibleMarkets.length === 1) return { status: "NO_ALTERNATIVE", reasonCode: "NO_ELIGIBLE_ALTERNATIVE", eligibleMarkets, excludedMarkets, recommendation: "HOLD", selectedMarketId: current.marketId }
  const candidates = eligibleMarkets.slice(1).sort(compare)
  const best = candidates[0]
  if (!best) throw new Error("yield candidate invariant failed")
  const improvement = BigInt(best.improvementVsHoldUnits)
  if (improvement <= 0n) return { status: "NO_ACTION", reasonCode: "COSTS_DOMINATE", eligibleMarkets, excludedMarkets, recommendation: "HOLD", selectedMarketId: current.marketId }
  if (improvement < BigInt(input.minimumImprovementUnits)) return { status: "NO_ACTION", reasonCode: "BELOW_MINIMUM_IMPROVEMENT", eligibleMarkets, excludedMarkets, recommendation: "HOLD", selectedMarketId: current.marketId }
  return { status: "ASSESSED", reasonCode: null, eligibleMarkets, excludedMarkets, recommendation: "MIGRATE", selectedMarketId: best.marketId }
}

export function normalizeYieldRate(ratePerPeriodRay: string, periodsPerYear: string): bigint {
  return BigInt(ratePerPeriodRay) * BigInt(periodsPerYear)
}

export function calculateYieldHorizonBenefit(amountUnits: string, annualRateRay: bigint, horizonSeconds: number): bigint {
  return BigInt(amountUnits) * annualRateRay * BigInt(horizonSeconds) / (RAY * YEAR_SECONDS)
}

function project(market: YieldEvaluationMarket, input: YieldScoutEvaluationInput, sourceExitCost: bigint, holding: boolean, holdNet: bigint): YieldComparison {
  if (market.incentiveRate.status === "unknown") throw new Error("unknown incentive cannot be projected")
  const baseAnnual = normalizeYieldRate(market.baseRatePerPeriodRay, market.periodBasis.periodsPerYear)
  const incentiveAnnual = market.incentiveRate.status === "valued" ? normalizeYieldRate(market.incentiveRate.ratePerPeriodRay, market.periodBasis.periodsPerYear) : 0n
  const baseBenefit = calculateYieldHorizonBenefit(input.amountUnits, baseAnnual, input.holdingHorizonSeconds)
  const incentiveBenefit = calculateYieldHorizonBenefit(input.amountUnits, incentiveAnnual, input.holdingHorizonSeconds)
  const entry = holding ? 0n : BigInt(market.entryCostUnits)
  const exit = BigInt(market.exitCostUnits)
  const net = baseBenefit + incentiveBenefit - entry - exit - sourceExitCost
  return {
    marketId: market.marketId,
    protocol: market.protocol,
    integrationId: market.integrationId,
    rateBasis: market.periodBasis.kind,
    baseRateSourceUri: market.periodBasis.source.uri,
    baseAnnualRateRay: baseAnnual.toString(),
    incentiveStatus: market.incentiveRate.status,
    incentiveValuationSourceUri: market.incentiveRate.status === "valued" ? market.incentiveRate.valuationSource.uri : null,
    incentiveAnnualRateRay: incentiveAnnual.toString(),
    horizonBaseBenefitUnits: baseBenefit.toString(),
    horizonIncentiveBenefitUnits: incentiveBenefit.toString(),
    entryCostUnits: entry.toString(),
    exitCostUnits: exit.toString(),
    sourceExitCostUnits: sourceExitCost.toString(),
    netBenefitUnits: net.toString(),
    improvementVsHoldUnits: holding ? "0" : (net - holdNet).toString(),
    uncertainty: market.uncertainty,
  }
}

function marketFailures(market: YieldEvaluationMarket, input: YieldScoutEvaluationInput, now: Date): string[] {
  const failures: string[] = []
  const integration = integrations[market.integrationId]
  if (integration.protocol !== market.protocol || integration.chainId !== input.dataChainId) failures.push("integration and protocol identity do not match")
  if (!sameAsset(input.asset, market.asset)) failures.push("market exposure is not the requested asset")
  if (market.asset.mechanics !== "plain_erc20") failures.push("token mechanics are unsupported")
  if (market.exposure !== "same_asset") failures.push("LP exposure is excluded")
  if (market.leverage) failures.push("leveraged exposure is excluded")
  if (market.dataStatus !== "current" || market.observedAtUtc === null) failures.push("market data is unknown")
  else if (stale(market.observedAtUtc, input, now)) failures.push("market data is stale")
  if (market.dataSource === null) failures.push("market data source is unknown")
  if (market.incentiveRate.status === "unknown") failures.push("incentive valuation is unknown")
  if (market.incentiveRate.status === "valued" && stale(market.incentiveRate.observedAtUtc, input, now)) failures.push("incentive valuation is stale")
  if (market.riskFlags.length > 0) failures.push(`risk flags are active: ${market.riskFlags.join(",")}`)
  return failures
}

function destinationFailures(market: YieldEvaluationMarket, input: YieldScoutEvaluationInput, now: Date): string[] {
  const failures = marketFailures(market, input, now)
  if (!input.allowedProtocols.includes(market.protocol)) failures.push("protocol is not allowed")
  if (market.supplyState !== "active") failures.push(`supply state is ${market.supplyState}`)
  if (market.withdrawalState !== "active") failures.push(`withdrawal state is ${market.withdrawalState}`)
  const requiredLiquidity = BigInt(input.minimumLiquidityUnits) > BigInt(input.withdrawalNeedsUnits) ? BigInt(input.minimumLiquidityUnits) : BigInt(input.withdrawalNeedsUnits)
  if (market.availableLiquidityUnits === null) failures.push("available liquidity is unknown")
  else if (BigInt(market.availableLiquidityUnits) < requiredLiquidity) failures.push("available liquidity is below requirement")
  if (market.capacity.kind === "unknown") failures.push("supply cap is unknown")
  if (market.capacity.kind === "capped" && BigInt(market.capacity.supplyCapUnits) - BigInt(market.totalSuppliedUnits) < BigInt(input.amountUnits)) failures.push("remaining supply capacity is insufficient")
  if (market.concentrationBps === null) failures.push("concentration is unknown")
  else if (market.concentrationBps > input.concentrationCapBps) failures.push("concentration exceeds cap")
  return failures
}

function snapshotFresh(input: YieldScoutEvaluationInput, now: Date): boolean {
  const captured = Date.parse(input.snapshot.capturedAtUtc)
  return input.snapshot.canonicality === "confirmed" && captured >= Date.parse(input.snapshot.blockTimestampUtc) && captured <= now.getTime() && !stale(input.snapshot.capturedAtUtc, input, now)
}

function stale(value: string, input: YieldScoutEvaluationInput, now: Date): boolean {
  const observed = Date.parse(value)
  return observed > now.getTime() || now.getTime() - observed > input.maxSnapshotAgeSeconds * 1_000
}

function sameAsset(left: YieldScoutEvaluationInput["asset"], right: YieldScoutEvaluationInput["asset"]): boolean {
  return left.chainId === right.chainId && left.address === right.address && left.symbol === right.symbol && left.decimals === right.decimals && left.mechanics === right.mechanics
}

function snapshotMismatches(input: YieldScoutEvaluationInput): string[] {
  const failures: string[] = []
  if (input.dataChainId !== input.snapshot.chainId) failures.push("snapshot chain does not match the data chain")
  if (!sameAsset(input.asset, input.snapshot.asset)) failures.push("request asset does not match snapshot asset")
  if (!sameAsset(input.asset, input.snapshot.costValuation.asset)) failures.push("cost valuation is not denominated in the requested asset")
  return failures
}

function compare(left: YieldComparison, right: YieldComparison): number {
  const difference = BigInt(right.netBenefitUnits) - BigInt(left.netBenefitUnits)
  return difference === 0n ? left.marketId.localeCompare(right.marketId) : difference > 0n ? 1 : -1
}

function refused(input: YieldScoutEvaluationInput, status: YieldExpectedResult["status"], reasonCode: Exclude<YieldExpectedResult["reasonCode"], null>, reasons: string[]): YieldExpectedResult {
  return { status, reasonCode, eligibleMarkets: [], excludedMarkets: [{ marketId: input.currentMarketId, reasons }], recommendation: "REFUSED", selectedMarketId: null }
}
