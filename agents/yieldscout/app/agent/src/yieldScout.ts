import { annualRateRay, horizonBenefitUnits, maxBigInt } from "./yieldMath.js";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  yieldScoutArtifact,
  yieldScoutRequest,
  type YieldMarketSnapshot,
  type YieldScoutArtifact,
  type YieldScoutRequest,
} from "./yieldSchemas.js";

const SUPPORTED_INTEGRATIONS = {
  "venus-core-supply-v1": { chainId: 56, protocol: "venus" },
  "aave-v3-bsc-supply-v1": { chainId: 56, protocol: "aave-v3" },
} as const;
const ASSUMPTIONS = [
  "rates remain unchanged over the stated holding horizon",
  "benefits and disclosed migration costs use requested-asset base units",
];
const LIMITATIONS = [
  "analysis only; no deposit, withdrawal, or migration transaction is signed",
  "annualized rates are simple rate projections, not APY or promised returns",
  "TVL and future liquidity are not inferred",
];
export const SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-base64url/1:";
export const COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-deflate-base64url/1:";
const MAX_DECOMPRESSED_TASK_BYTES = 65_536;
const MAX_ENCODED_TASK_CHARS = Math.ceil(MAX_DECOMPRESSED_TASK_BYTES / 3) * 4;
type Comparison = YieldScoutArtifact["eligibleMarkets"][number];

export function encodeSignedTaskTransport(text: string): string {
  return `${SIGNED_TASK_TRANSPORT_PREFIX}${Buffer.from(text, "utf8").toString("base64url")}`;
}

export function encodeCompressedSignedTaskTransport(text: string): string {
  return `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}${deflateRawSync(Buffer.from(text, "utf8")).toString("base64url")}`;
}

function decodeSignedTaskTransport(text: string): string | null {
  const compressed = text.startsWith(COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX);
  if (!compressed && !text.startsWith(SIGNED_TASK_TRANSPORT_PREFIX)) {
    return Buffer.byteLength(text, "utf8") <= MAX_DECOMPRESSED_TASK_BYTES ? text : null;
  }
  const prefix = compressed ? COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX : SIGNED_TASK_TRANSPORT_PREFIX;
  const payload = text.slice(prefix.length);
  if (
    payload.length > MAX_ENCODED_TASK_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    payload.length % 4 === 1
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const decoded = compressed ? inflateRawSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_TASK_BYTES }) : bytes;
    if (decoded.length > MAX_DECOMPRESSED_TASK_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}

export function analyzeYieldScoutText(text: string, now = new Date()): string {
  const decoded = decodeSignedTaskTransport(text);
  if (decoded === null) {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null, ["request is not valid JSON"]));
  }
  let input: unknown;
  try {
    input = JSON.parse(decoded);
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null, ["request is not valid JSON"]));
  }
  const parsed = yieldScoutRequest.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify(refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now, null, ["request does not match the closed schema"]));
  }
  return JSON.stringify(analyzeYieldScout(parsed.data, now));
}

export function analyzeYieldScout(request: YieldScoutRequest, now = new Date()): YieldScoutArtifact {
  if (request.capability !== "analysis" || request.executionChainId !== null) {
    return refusal("UNSUPPORTED_POSITION", "ANALYSIS_ONLY", now, request, ["YieldScout produces analysis only"]);
  }
  if (!request.analysisAuthorized) {
    return refusal("UNSUPPORTED_POSITION", "AUTHORITY_MISMATCH", now, request, ["requester did not authorize this analysis"]);
  }
  const mismatchReasons = snapshotMismatches(request);
  if (mismatchReasons.length > 0) {
    return refusal("ASSESSMENT_INCOMPLETE", "SNAPSHOT_TARGET_MISMATCH", now, request, mismatchReasons);
  }
  if (!snapshotFresh(request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_SNAPSHOT", now, request, ["snapshot is not confirmed and current"]);
  }
  if (request.snapshot.costValuation.status !== "current") {
    return refusal("ASSESSMENT_INCOMPLETE", "COST_VALUATION_UNKNOWN", now, request, ["migration cost valuation is unknown"]);
  }
  if (isStale(request.snapshot.costValuation.observedAtUtc, request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_COST_VALUATION", now, request, ["migration cost valuation is stale"]);
  }
  const current = request.snapshot.markets.find((market) => market.marketId === request.currentMarketId);
  if (!current) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_NOT_FOUND", now, request, ["current market is absent"]);
  }
  const currentFailures = marketFailures(current, request, now);
  const currentIncomplete = currentFailures.filter((reason) =>
    reason.includes("unknown") || reason.includes("stale") || reason.includes("source"),
  );
  if (currentIncomplete.length > 0) {
    return refusal("ASSESSMENT_INCOMPLETE", "CURRENT_MARKET_DATA_INCOMPLETE", now, request, currentIncomplete);
  }
  if (currentFailures.length > 0) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", now, request, currentFailures);
  }
  if (current.withdrawalState !== "active") {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", now, request, [`withdrawal state is ${current.withdrawalState}`]);
  }
  if (current.availableLiquidityUnits === null) {
    return refusal("ASSESSMENT_INCOMPLETE", "CURRENT_MARKET_DATA_INCOMPLETE", now, request, ["withdrawal liquidity is unknown"]);
  }
  if (BigInt(current.availableLiquidityUnits) < BigInt(request.amountUnits)) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", now, request, ["source withdrawal liquidity is insufficient"]);
  }
  if (BigInt(current.exitCostUnits) > BigInt(request.gasAllowanceUnits)) {
    return refusal("UNSUPPORTED_POSITION", "CURRENT_MARKET_UNSUPPORTED", now, request, ["source exit cost exceeds gas allowance"]);
  }
  const hold = comparisonFor(current, request, 0n, true);
  const eligible: Comparison[] = [hold];
  const excluded: YieldScoutArtifact["excludedMarkets"] = [];
  for (const market of request.snapshot.markets) {
    if (market.marketId === current.marketId) continue;
    const failures = destinationFailures(market, request, now);
    const routeCost = BigInt(current.exitCostUnits) + BigInt(market.entryCostUnits) + BigInt(market.exitCostUnits);
    if (routeCost > BigInt(request.gasAllowanceUnits)) failures.push("migration costs exceed gas allowance");
    if (failures.length > 0) {
      excluded.push({ marketId: market.marketId, reasons: [...new Set(failures)] });
      continue;
    }
    eligible.push(comparisonFor(market, request, BigInt(current.exitCostUnits), false, BigInt(hold.netBenefitUnits)));
  }
  if (eligible.length === 1) {
    return artifact(request, now, "NO_ALTERNATIVE", "NO_ELIGIBLE_ALTERNATIVE", eligible, excluded, "HOLD", current.marketId, "No supported destination satisfies the requested safety and availability constraints.");
  }
  const best = eligible.slice(1).sort(compareCandidates)[0];
  if (!best) throw new Error("eligible destination invariant failed");
  const improvement = BigInt(best.improvementVsHoldUnits);
  if (improvement <= 0n) {
    return artifact(request, now, "NO_ACTION", "COSTS_DOMINATE", eligible, excluded, "HOLD", current.marketId, "Holding has at least as much estimated horizon benefit after disclosed costs.");
  }
  if (improvement < BigInt(request.minimumImprovementUnits)) {
    return artifact(request, now, "NO_ACTION", "BELOW_MINIMUM_IMPROVEMENT", eligible, excluded, "HOLD", current.marketId, "The best eligible alternative does not meet the minimum improvement threshold.");
  }
  return artifact(request, now, "ASSESSED", null, eligible, excluded, "MIGRATE", best.marketId, "The selected market has the highest estimated horizon benefit and clears the minimum improvement threshold.");
}

function snapshotMismatches(request: YieldScoutRequest): string[] {
  const failures: string[] = [];
  if (request.dataChainId !== request.snapshot.chainId) failures.push("snapshot chain does not match the data chain");
  if (!sameAsset(request.asset, request.snapshot.asset)) failures.push("request asset does not match snapshot asset");
  if (!sameAsset(request.asset, request.snapshot.costValuation.asset)) failures.push("cost valuation is not denominated in the requested asset");
  return failures;
}

function snapshotFresh(request: YieldScoutRequest, now: Date): boolean {
  if (request.snapshot.canonicality !== "confirmed") return false;
  const capturedAt = Date.parse(request.snapshot.capturedAtUtc);
  const blockAt = Date.parse(request.snapshot.blockTimestampUtc);
  return capturedAt >= blockAt && capturedAt <= now.getTime() && !isStale(request.snapshot.capturedAtUtc, request, now);
}

function marketFailures(market: YieldMarketSnapshot, request: YieldScoutRequest, now: Date): string[] {
  const failures: string[] = [];
  const integration = SUPPORTED_INTEGRATIONS[market.integrationId];
  if (integration.protocol !== market.protocol || integration.chainId !== request.dataChainId) failures.push("integration and protocol identity do not match");
  if (!sameAsset(request.asset, market.asset)) failures.push("market exposure is not the requested asset");
  if (market.asset.mechanics !== "plain_erc20") failures.push("token mechanics are unsupported");
  if (market.exposure !== "same_asset") failures.push("LP exposure is excluded");
  if (market.leverage) failures.push("leveraged exposure is excluded");
  if (market.dataStatus !== "current" || market.observedAtUtc === null) failures.push("market data is unknown");
  else if (isStale(market.observedAtUtc, request, now)) failures.push("market data is stale");
  if (market.dataSource === null) failures.push("market data source is unknown");
  if (market.incentiveRate.status === "unknown") failures.push("incentive valuation is unknown");
  if (market.incentiveRate.status === "valued" && isStale(market.incentiveRate.observedAtUtc, request, now)) failures.push("incentive valuation is stale");
  if (market.riskFlags.length > 0) failures.push(`risk flags are active: ${market.riskFlags.join(",")}`);
  return failures;
}

function destinationFailures(market: YieldMarketSnapshot, request: YieldScoutRequest, now: Date): string[] {
  const failures = marketFailures(market, request, now);
  if (!request.allowedProtocols.includes(market.protocol)) failures.push("protocol is not allowed");
  if (market.supplyState !== "active") failures.push(`supply state is ${market.supplyState}`);
  if (market.withdrawalState !== "active") failures.push(`withdrawal state is ${market.withdrawalState}`);
  const requiredLiquidity = maxBigInt(BigInt(request.minimumLiquidityUnits), BigInt(request.withdrawalNeedsUnits));
  if (market.availableLiquidityUnits === null) failures.push("available liquidity is unknown");
  else if (BigInt(market.availableLiquidityUnits) < requiredLiquidity) failures.push("available liquidity is below requirement");
  if (market.capacity.kind === "unknown") failures.push("supply cap is unknown");
  if (market.capacity.kind === "capped") {
    const remaining = BigInt(market.capacity.supplyCapUnits) - BigInt(market.totalSuppliedUnits);
    if (remaining < BigInt(request.amountUnits)) failures.push("remaining supply capacity is insufficient");
  }
  if (market.concentrationBps === null) failures.push("concentration is unknown");
  else if (market.concentrationBps > request.concentrationCapBps) failures.push("concentration exceeds cap");
  return failures;
}

function comparisonFor(
  market: YieldMarketSnapshot,
  request: YieldScoutRequest,
  sourceExitCost: bigint,
  holding: boolean,
  holdNetBenefit = 0n,
): Comparison {
  if (market.incentiveRate.status === "unknown") {
    throw new Error("incentive valuation invariant failed");
  }
  const baseAnnual = annualRateRay(market.baseRatePerPeriodRay, market.periodBasis.periodsPerYear);
  const incentiveAnnual = market.incentiveRate.status === "valued"
    ? annualRateRay(market.incentiveRate.ratePerPeriodRay, market.periodBasis.periodsPerYear)
    : 0n;
  const baseBenefit = horizonBenefitUnits(request.amountUnits, baseAnnual, request.holdingHorizonSeconds);
  const incentiveBenefit = horizonBenefitUnits(request.amountUnits, incentiveAnnual, request.holdingHorizonSeconds);
  const entryCost = holding ? 0n : BigInt(market.entryCostUnits);
  const exitCost = BigInt(market.exitCostUnits);
  const netBenefit = baseBenefit + incentiveBenefit - entryCost - exitCost - sourceExitCost;
  return {
    marketId: market.marketId,
    protocol: market.protocol,
    integrationId: market.integrationId,
    rateBasis: market.periodBasis.kind,
    baseRateSourceUri: market.periodBasis.source.uri,
    baseAnnualRateRay: baseAnnual.toString(),
    incentiveStatus: market.incentiveRate.status,
    incentiveValuationSourceUri: market.incentiveRate.status === "valued"
      ? market.incentiveRate.valuationSource.uri
      : null,
    incentiveAnnualRateRay: incentiveAnnual.toString(),
    horizonBaseBenefitUnits: baseBenefit.toString(),
    horizonIncentiveBenefitUnits: incentiveBenefit.toString(),
    entryCostUnits: entryCost.toString(),
    exitCostUnits: exitCost.toString(),
    sourceExitCostUnits: sourceExitCost.toString(),
    netBenefitUnits: netBenefit.toString(),
    improvementVsHoldUnits: holding ? "0" : (netBenefit - holdNetBenefit).toString(),
    uncertainty: market.uncertainty,
  };
}

function artifact(
  request: YieldScoutRequest,
  now: Date,
  status: YieldScoutArtifact["status"],
  reasonCode: YieldScoutArtifact["reasonCode"],
  eligibleMarkets: Comparison[],
  excludedMarkets: YieldScoutArtifact["excludedMarkets"],
  recommendation: "HOLD" | "MIGRATE",
  selectedMarketId: string,
  recommendationReason: string,
): YieldScoutArtifact {
  return yieldScoutArtifact.parse({
    schemaVersion: "knot.yield.artifact/1",
    category: "yield",
    capability: "analysis",
    taskId: request.taskId,
    status,
    reasonCode,
    assessedAtUtc: now.toISOString(),
    evidence: evidenceFrom(request),
    currentMarketId: request.currentMarketId,
    selectedMarketId,
    eligibleMarkets,
    excludedMarkets,
    recommendation,
    recommendationReason,
    assumptions: ASSUMPTIONS,
    limitations: LIMITATIONS,
  });
}

function refusal(
  status: YieldScoutArtifact["status"],
  reasonCode: Exclude<YieldScoutArtifact["reasonCode"], null>,
  now: Date,
  request: YieldScoutRequest | null,
  reasons: string[],
): YieldScoutArtifact {
  return yieldScoutArtifact.parse({
    schemaVersion: "knot.yield.artifact/1",
    category: "yield",
    capability: "analysis",
    taskId: request?.taskId ?? null,
    status,
    reasonCode,
    assessedAtUtc: now.toISOString(),
    evidence: request ? evidenceFrom(request) : null,
    currentMarketId: request?.currentMarketId ?? null,
    selectedMarketId: null,
    eligibleMarkets: [],
    excludedMarkets: [{ marketId: request?.currentMarketId ?? "request", reasons }],
    recommendation: "REFUSED",
    recommendationReason: "The assessment failed closed because required data or support is missing.",
    assumptions: ["no recommendation is produced from incomplete inputs"],
    limitations: LIMITATIONS,
  });
}

function evidenceFrom(request: YieldScoutRequest) {
  return {
    snapshotId: request.snapshot.snapshotId,
    chainId: request.snapshot.chainId,
    blockNumber: request.snapshot.blockNumber,
    blockHash: request.snapshot.blockHash,
    blockTimestampUtc: request.snapshot.blockTimestampUtc,
    capturedAtUtc: request.snapshot.capturedAtUtc,
    sources: request.snapshot.sources.map((source) => source.uri),
  };
}

function sameAsset(left: YieldScoutRequest["asset"], right: YieldScoutRequest["asset"]): boolean {
  return left.chainId === right.chainId && left.address === right.address && left.symbol === right.symbol && left.decimals === right.decimals && left.mechanics === right.mechanics;
}

function isStale(observedAtUtc: string, request: YieldScoutRequest, now: Date): boolean {
  const observed = Date.parse(observedAtUtc);
  return observed > now.getTime() || now.getTime() - observed > request.maxSnapshotAgeSeconds * 1_000;
}

function compareCandidates(left: Comparison, right: Comparison): number {
  const leftNet = BigInt(left.netBenefitUnits);
  const rightNet = BigInt(right.netBenefitUnits);
  if (leftNet === rightNet) return left.marketId.localeCompare(right.marketId);
  return leftNet > rightNet ? -1 : 1;
}
