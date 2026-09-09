import {
  yieldScoutArtifact,
  yieldScoutRequest,
  type YieldMarketSnapshot,
  type YieldScoutArtifact,
  type YieldScoutRequest,
} from "./schemas.ts"
import { annualRateRay, horizonBenefitUnits, maxBigInt } from "./math.ts"
import { supportedYieldIntegrations } from "./integrations.ts"

type ArtifactStatus = YieldScoutArtifact["status"]
type Comparison = YieldScoutArtifact["eligibleMarkets"][number]

export function analyzeYieldScoutText(text: string, now = new Date()): string {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null, ["request is not valid JSON"]))
  }
  const parsed = yieldScoutRequest.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    return JSON.stringify(refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now, null, issues))
  }
  return JSON.stringify(analyzeYieldScout(parsed.data, now))
}

export function analyzeYieldScout(request: YieldScoutRequest, now = new Date()): YieldScoutArtifact {
  const mismatchReasons = snapshotMismatches(request)
  if (mismatchReasons.length > 0) {
    return refusal("ASSESSMENT_INCOMPLETE", "SNAPSHOT_TARGET_MISMATCH", now, request, mismatchReasons)
  }
  if (request.snapshot.canonicality !== "confirmed" || isStale(request.snapshot.capturedAtUtc, request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_SNAPSHOT", now, request, ["snapshot is not confirmed and current"])
  }
  if (request.snapshot.costValuation.status !== "current") {
    return refusal("ASSESSMENT_INCOMPLETE", "COST_VALUATION_UNKNOWN", now, request, ["gas cost valuation is unknown"])
  }
  if (isStale(request.snapshot.costValuation.observedAtUtc, request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_COST_VALUATION", now, request, ["gas cost valuation is stale"])
  }
  const current = request.snapshot.markets.find((market) => market.marketId === request.currentMarketId)
  if (!current) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_NOT_FOUND", now, request, ["current market is absent"])
  }
  const currentSafety = sourceSafetyFailures(current, request, now)
  if (currentSafety.some((reason) => reason.includes("unknown") || reason.includes("stale"))) {
    return refusal("ASSESSMENT_INCOMPLETE", "CURRENT_MARKET_DATA_INCOMPLETE", now, request, currentSafety)
  }
  const unsupportedCurrent = currentSafety.filter((reason) =>
    reason.includes("integration") ||
    reason.includes("requested asset") ||
    reason.includes("LP exposure") ||
    reason.includes("leveraged exposure"),
  )
  if (unsupportedCurrent.length > 0) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", now, request, unsupportedCurrent)
  }
  const hold = comparisonFor(current, request, 0n, true)
  const eligible: Comparison[] = [hold]
  const excluded: YieldScoutArtifact["excludedMarkets"] = []
  for (const market of request.snapshot.markets) {
    if (market.marketId === current.marketId) continue
    const failures = destinationFailures(market, request, now)
    if (currentSafety.length > 0) failures.push(...currentSafety.map((reason) => `source: ${reason}`))
    const sourceExitCost = BigInt(current.exitCostUnits)
    const routeCost = sourceExitCost + BigInt(market.entryCostUnits) + BigInt(market.exitCostUnits)
    if (routeCost > BigInt(request.gasAllowanceUnits)) failures.push("migration costs exceed gas allowance")
    if (failures.length > 0) {
      excluded.push({ marketId: market.marketId, reasons: [...new Set(failures)] })
      continue
    }
    eligible.push(comparisonFor(market, request, sourceExitCost, false, BigInt(hold.netBenefitUnits)))
  }
  if (eligible.length === 1) {
    return artifact(request, now, "NO_ALTERNATIVE", "NO_ELIGIBLE_ALTERNATIVE", eligible, excluded, "HOLD", current.marketId,
      "No supported destination satisfies the requested safety and availability constraints.")
  }
  const candidates = eligible.slice(1).sort(compareCandidates)
  const best = candidates[0]
  if (!best) throw new Error("eligible destination invariant failed")
  const improvement = BigInt(best.improvementVsHoldUnits)
  if (improvement <= 0n) {
    return artifact(request, now, "NO_ACTION", "COSTS_DOMINATE", eligible, excluded, "HOLD", current.marketId,
      "Holding has at least as much estimated horizon benefit after disclosed costs.")
  }
  if (improvement < BigInt(request.minimumImprovementUnits)) {
    return artifact(request, now, "NO_ACTION", "BELOW_MINIMUM_IMPROVEMENT", eligible, excluded, "HOLD", current.marketId,
      "The best eligible alternative does not meet the minimum improvement threshold.")
  }
  return artifact(request, now, "ASSESSED", null, eligible, excluded, "MIGRATE", best.marketId,
    "The selected market has the highest estimated horizon benefit and clears the minimum improvement threshold.")
}

function snapshotMismatches(request: YieldScoutRequest): string[] {
  const failures: string[] = []
  if (!sameAsset(request.asset, request.snapshot.asset)) failures.push("request asset does not match snapshot asset")
  if (!sameAsset(request.asset, request.snapshot.costValuation.asset)) failures.push("cost valuation is not denominated in the requested asset")
  return failures
}

function sourceSafetyFailures(market: YieldMarketSnapshot, request: YieldScoutRequest, now: Date): string[] {
  const failures = commonFailures(market, request, now)
  if (market.withdrawalState !== "active") failures.push(`withdrawal state is ${market.withdrawalState}`)
  if (market.availableLiquidityUnits === null) failures.push("withdrawal liquidity is unknown")
  else if (BigInt(market.availableLiquidityUnits) < BigInt(request.amountUnits)) failures.push("source withdrawal liquidity is insufficient")
  if (BigInt(market.exitCostUnits) > BigInt(request.gasAllowanceUnits)) failures.push("hold exit cost exceeds gas allowance")
  return failures
}

function destinationFailures(market: YieldMarketSnapshot, request: YieldScoutRequest, now: Date): string[] {
  const failures = commonFailures(market, request, now)
  if (!request.allowedProtocols.includes(market.protocol)) failures.push("protocol is not allowed")
  if (market.supplyState !== "active") failures.push(`supply state is ${market.supplyState}`)
  if (market.withdrawalState !== "active") failures.push(`withdrawal state is ${market.withdrawalState}`)
  const requiredLiquidity = maxBigInt(BigInt(request.minimumLiquidityUnits), BigInt(request.withdrawalNeedsUnits))
  if (market.availableLiquidityUnits === null) failures.push("available liquidity is unknown")
  else if (BigInt(market.availableLiquidityUnits) < requiredLiquidity) failures.push("available liquidity is below requirement")
  if (market.capacity.kind === "unknown") failures.push("supply cap is unknown")
  if (market.capacity.kind === "capped") {
    const remaining = BigInt(market.capacity.supplyCapUnits) - BigInt(market.totalSuppliedUnits)
    if (remaining < BigInt(request.amountUnits)) failures.push("remaining supply capacity is insufficient")
  }
  if (market.concentrationBps === null) failures.push("concentration is unknown")
  else if (market.concentrationBps > request.concentrationCapBps) failures.push("concentration exceeds cap")
  return failures
}

function commonFailures(market: YieldMarketSnapshot, request: YieldScoutRequest, now: Date): string[] {
  const failures: string[] = []
  const profile = supportedYieldIntegrations[market.integrationId]
  if (profile.protocol !== market.protocol) failures.push("integration and protocol do not match")
  if (!sameAsset(request.asset, market.asset)) failures.push("market exposure is not the requested asset")
  if (market.exposure !== "same_asset") failures.push("LP exposure is excluded")
  if (market.leverage) failures.push("leveraged exposure is excluded")
  if (market.dataStatus !== "current") failures.push("market data is unknown")
  if (market.observedAtUtc === null) failures.push("market observation time is unknown")
  else if (isStale(market.observedAtUtc, request, now)) failures.push("market data is stale")
  if (market.incentiveRate.status === "unknown") failures.push("incentive valuation is unknown")
  return failures
}

function comparisonFor(
  market: YieldMarketSnapshot,
  request: YieldScoutRequest,
  sourceExitCost: bigint,
  holding: boolean,
  holdNetBenefit = 0n,
): Comparison {
  const baseAnnual = annualRateRay(market.baseRatePerPeriodRay, market.periodBasis.periodsPerYear)
  const incentiveAnnual = market.incentiveRate.status === "valued"
    ? annualRateRay(market.incentiveRate.ratePerPeriodRay, market.periodBasis.periodsPerYear)
    : 0n
  const baseBenefit = horizonBenefitUnits(request.amountUnits, baseAnnual, request.holdingHorizonSeconds)
  const incentiveBenefit = horizonBenefitUnits(request.amountUnits, incentiveAnnual, request.holdingHorizonSeconds)
  const entryCost = holding ? 0n : BigInt(market.entryCostUnits)
  const exitCost = BigInt(market.exitCostUnits)
  const netBenefit = baseBenefit + incentiveBenefit - entryCost - exitCost - sourceExitCost
  return {
    marketId: market.marketId,
    protocol: market.protocol,
    integrationId: market.integrationId,
    baseAnnualRateRay: baseAnnual.toString(),
    incentiveAnnualRateRay: incentiveAnnual.toString(),
    horizonBaseBenefitUnits: baseBenefit.toString(),
    horizonIncentiveBenefitUnits: incentiveBenefit.toString(),
    entryCostUnits: entryCost.toString(),
    exitCostUnits: exitCost.toString(),
    sourceExitCostUnits: sourceExitCost.toString(),
    netBenefitUnits: netBenefit.toString(),
    improvementVsHoldUnits: holding ? "0" : (netBenefit - holdNetBenefit).toString(),
    uncertainty: market.uncertainty,
  }
}

function artifact(
  request: YieldScoutRequest,
  now: Date,
  status: ArtifactStatus,
  reasonCode: string | null,
  eligibleMarkets: Comparison[],
  excludedMarkets: YieldScoutArtifact["excludedMarkets"],
  recommendation: "HOLD" | "MIGRATE",
  selectedMarketId: string,
  recommendationReason: string,
): YieldScoutArtifact {
  return yieldScoutArtifact.parse({
    schemaVersion: "knot.yield.artifact/1", category: "yield", capability: "analysis", taskId: request.taskId,
    status, reasonCode, assessedAtUtc: now.toISOString(), snapshotId: request.snapshot.snapshotId,
    currentMarketId: request.currentMarketId, selectedMarketId, eligibleMarkets, excludedMarkets, recommendation,
    recommendationReason,
    assumptions: ["rates remain unchanged over the stated holding horizon", "all benefits and gas costs use requested-asset base units"],
    limitations: ["analysis only", "does not sign or execute transactions", "current annualized rates are not promised returns"],
  })
}

function refusal(
  status: ArtifactStatus,
  reasonCode: string,
  now: Date,
  request: YieldScoutRequest | null,
  reasons: string[],
): YieldScoutArtifact {
  return yieldScoutArtifact.parse({
    schemaVersion: "knot.yield.artifact/1", category: "yield", capability: "analysis", taskId: request?.taskId ?? null,
    status, reasonCode, assessedAtUtc: now.toISOString(), snapshotId: request?.snapshot.snapshotId ?? null,
    currentMarketId: request?.currentMarketId ?? null, selectedMarketId: null, eligibleMarkets: [],
    excludedMarkets: [{ marketId: request?.currentMarketId ?? "request", reasons }], recommendation: "REFUSED",
    recommendationReason: "The assessment failed closed because required data or support is missing.",
    assumptions: ["no recommendation is produced from incomplete inputs"],
    limitations: ["analysis only", "does not sign or execute transactions", "current annualized rates are not promised returns"],
  })
}

function sameAsset(left: YieldScoutRequest["asset"], right: YieldScoutRequest["asset"]): boolean {
  return left.chainId === right.chainId && left.address === right.address && left.decimals === right.decimals
}

function isStale(observedAtUtc: string, request: YieldScoutRequest, now: Date): boolean {
  return Math.abs(now.getTime() - new Date(observedAtUtc).getTime()) / 1000 > request.maxSnapshotAgeSeconds
}

function compareCandidates(left: Comparison, right: Comparison): number {
  const leftNet = BigInt(left.netBenefitUnits)
  const rightNet = BigInt(right.netBenefitUnits)
  if (leftNet === rightNet) return left.marketId.localeCompare(right.marketId)
  return leftNet > rightNet ? -1 : 1
}
