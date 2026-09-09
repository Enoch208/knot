import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForClaim } from "@bnbagent/sdk/erc8183";
import {
  COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX,
  SIGNED_TASK_TRANSPORT_PREFIX,
  analyzeYieldScout,
  analyzeYieldScoutText,
  encodeCompressedSignedTaskTransport,
  encodeSignedTaskTransport,
} from "../src/yieldScout.js";
import { yieldScoutArtifact } from "../src/yieldSchemas.js";
import { NOW, yieldFixture } from "./yieldFixture.js";

function destination(request: ReturnType<typeof yieldFixture>) {
  const market = request.snapshot.markets.find((candidate) => candidate.marketId === "aave-usdc");
  assert.ok(market);
  return market;
}

test("compares explicit rate bases and recommends a threshold-clearing migration", () => {
  const artifact = analyzeYieldScout(yieldFixture(), NOW);
  assert.equal(artifact.status, "ASSESSED");
  assert.equal(artifact.recommendation, "MIGRATE");
  assert.equal(artifact.selectedMarketId, "aave-usdc");
  assert.equal(artifact.evidence?.chainId, 56);
  assert.deepEqual(artifact.eligibleMarkets.map((market) => market.rateBasis), ["per_second", "per_block"]);
  assert.equal(artifact.eligibleMarkets[0]?.incentiveAnnualRateRay, "0");
  assert.equal(artifact.eligibleMarkets[0]?.incentiveStatus, "none");
  assert.equal(artifact.eligibleMarkets[0]?.incentiveValuationSourceUri, null);
  assert.match(artifact.eligibleMarkets[1]?.incentiveValuationSourceUri ?? "", /^bsc:/);
  assert.equal(yieldScoutArtifact.safeParse(artifact).success, true);
  assert.equal("apy" in artifact, false);
  assert.equal("tvl" in artifact, false);
});

test("refuses execution and missing analysis permission", () => {
  const execution = yieldFixture();
  execution.capability = "execution";
  assert.equal(analyzeYieldScout(execution, NOW).reasonCode, "ANALYSIS_ONLY");
  const authority = yieldFixture();
  authority.analysisAuthorized = false;
  assert.equal(analyzeYieldScout(authority, NOW).reasonCode, "AUTHORITY_MISMATCH");
});

test("fails stale, orphaned, and future snapshots closed", () => {
  const stale = yieldFixture();
  stale.snapshot.capturedAtUtc = "2026-09-09T11:00:00.000Z";
  assert.equal(analyzeYieldScout(stale, NOW).status, "STALE_SNAPSHOT");
  const orphaned = yieldFixture();
  orphaned.snapshot.canonicality = "orphaned";
  assert.equal(analyzeYieldScout(orphaned, NOW).status, "STALE_SNAPSHOT");
  const future = yieldFixture();
  future.snapshot.capturedAtUtc = "2026-09-09T12:01:00.000Z";
  assert.equal(analyzeYieldScout(future, NOW).status, "STALE_SNAPSHOT");
});

test("requires current cost valuation instead of silently using zero", () => {
  const request = yieldFixture();
  request.snapshot.costValuation = {
    status: "unknown",
    asset: request.asset,
    observedAtUtc: null,
    source: null,
  };
  const artifact = analyzeYieldScout(request, NOW);
  assert.equal(artifact.status, "ASSESSMENT_INCOMPLETE");
  assert.equal(artifact.reasonCode, "COST_VALUATION_UNKNOWN");
});

test("requires gross rate and incentive valuation provenance", () => {
  const incentive = yieldFixture();
  destination(incentive).incentiveRate = { status: "unknown" };
  const artifact = analyzeYieldScout(incentive, NOW);
  assert.equal(artifact.status, "NO_ALTERNATIVE");
  assert.match(artifact.excludedMarkets[0]?.reasons.join(" ") ?? "", /incentive valuation is unknown/);
  const missingSource = JSON.parse(JSON.stringify(yieldFixture())) as Record<string, unknown>;
  const snapshot = missingSource.snapshot as { markets: Array<Record<string, unknown>> };
  snapshot.markets[0]!.periodBasis = { kind: "per_second", periodsPerYear: "31536000" };
  const invalid = JSON.parse(analyzeYieldScoutText(JSON.stringify(missingSource), NOW)) as Record<string, unknown>;
  assert.equal(invalid.reasonCode, "SCHEMA_VALIDATION_FAILED");
});

test("excludes liquidity, cap, concentration, and active-risk failures", () => {
  const request = yieldFixture();
  const market = destination(request);
  market.availableLiquidityUnits = null;
  market.capacity = { kind: "unknown", supplyCapUnits: null };
  market.concentrationBps = null;
  market.riskFlags = ["INCIDENT_ACTIVE"];
  const artifact = analyzeYieldScout(request, NOW);
  const reasons = artifact.excludedMarkets[0]?.reasons.join(" ") ?? "";
  assert.match(reasons, /liquidity is unknown/);
  assert.match(reasons, /supply cap is unknown/);
  assert.match(reasons, /concentration is unknown/);
  assert.match(reasons, /INCIDENT_ACTIVE/);
});

test("refuses LP, leverage, token mechanics, and integration drift", () => {
  const current = yieldFixture();
  current.snapshot.markets[0]!.exposure = "lp";
  current.snapshot.markets[0]!.leverage = true;
  assert.equal(analyzeYieldScout(current, NOW).reasonCode, "CURRENT_MARKET_UNSUPPORTED");
  const mechanics = yieldFixture();
  mechanics.snapshot.markets[0]!.asset.mechanics = "fee_on_transfer";
  assert.equal(analyzeYieldScout(mechanics, NOW).reasonCode, "CURRENT_MARKET_UNSUPPORTED");
  const integration = yieldFixture();
  destination(integration).protocol = "venus";
  const artifact = analyzeYieldScout(integration, NOW);
  assert.match(artifact.excludedMarkets[0]?.reasons.join(" ") ?? "", /integration and protocol identity/);
});

test("holds when costs dominate or improvement is below the threshold", () => {
  const costs = yieldFixture();
  destination(costs).entryCostUnits = "60000000";
  destination(costs).exitCostUnits = "60000000";
  costs.gasAllowanceUnits = "150000000";
  assert.equal(analyzeYieldScout(costs, NOW).reasonCode, "COSTS_DOMINATE");
  const threshold = yieldFixture();
  threshold.minimumImprovementUnits = "100000000";
  assert.equal(analyzeYieldScout(threshold, NOW).reasonCode, "BELOW_MINIMUM_IMPROVEMENT");
});

test("preserves signed JSON through the ERC-8183 claim sanitizer", () => {
  const raw = JSON.stringify(yieldFixture());
  const encoded = encodeSignedTaskTransport(raw);
  assert.match(raw, /[\[\]]/);
  assert.ok(encoded.startsWith(SIGNED_TASK_TRANSPORT_PREFIX));
  assert.equal(sanitizeForClaim(encoded), encoded);
  const artifact = JSON.parse(analyzeYieldScoutText(encoded, NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "ASSESSED");
  assert.equal(artifact.taskId, "yield-task-1");
});

test("bounded compression preserves a large signed request under the claim limit", () => {
  const raw = JSON.stringify(yieldFixture());
  const encoded = encodeCompressedSignedTaskTransport(raw);
  assert.ok(encoded.startsWith(COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX));
  assert.ok(encoded.length < encodeSignedTaskTransport(raw).length);
  assert.equal(sanitizeForClaim(encoded), encoded);
  const artifact = JSON.parse(analyzeYieldScoutText(encoded, NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "ASSESSED");
  assert.equal(artifact.taskId, "yield-task-1");
  const malformed = `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}eJw`;
  assert.equal(JSON.parse(analyzeYieldScoutText(malformed, NOW)).reasonCode, "INVALID_JSON");
});

test("rejects oversized raw, encoded, and compressed task transports", () => {
  const oversized = "a".repeat(65_537);
  const encoded = `${SIGNED_TASK_TRANSPORT_PREFIX}${Buffer.from(oversized, "utf8").toString("base64url")}`;
  const compressed = `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}${"A".repeat(87_388)}`;
  assert.equal(JSON.parse(analyzeYieldScoutText(oversized, NOW)).reasonCode, "INVALID_JSON");
  assert.equal(JSON.parse(analyzeYieldScoutText(encoded, NOW)).reasonCode, "INVALID_JSON");
  assert.equal(JSON.parse(analyzeYieldScoutText(compressed, NOW)).reasonCode, "INVALID_JSON");
});

test("malformed transport and unknown fields fail closed", () => {
  const malformed = `${SIGNED_TASK_TRANSPORT_PREFIX}%%%`;
  const malformedArtifact = JSON.parse(analyzeYieldScoutText(malformed, NOW)) as Record<string, unknown>;
  assert.equal(malformedArtifact.reasonCode, "INVALID_JSON");
  const unknown = { ...yieldFixture(), trustedByBrowser: true };
  const unknownArtifact = JSON.parse(analyzeYieldScoutText(JSON.stringify(unknown), NOW)) as Record<string, unknown>;
  assert.equal(unknownArtifact.reasonCode, "SCHEMA_VALIDATION_FAILED");
  assert.equal(unknownArtifact.evidence, null);
});
