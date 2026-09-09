import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForClaim } from "@bnbagent/sdk/erc8183";
import {
  SIGNED_TASK_TRANSPORT_PREFIX,
  analyzeGridQuant,
  analyzeGridQuantText,
  encodeSignedTaskTransport,
} from "../src/gridQuant.js";
import { gridQuantArtifact } from "../src/gridSchemas.js";
import { NOW, gridFixture } from "./gridFixture.js";

test("returns a typed grid plan from pinned BSC mainnet evidence", () => {
  const artifact = analyzeGridQuant(gridFixture(), NOW);
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.reasonCode, "PLAN");
  assert.equal(artifact.evidence?.chainId, 56);
  assert.equal(artifact.result?.outcome, "PLAN");
  if (artifact.result?.outcome !== "PLAN") return;
  assert.deepEqual(artifact.result.levels.map((level) => level.priceUnits), ["50000", "60000", "70000", "80000"]);
  assert.equal(artifact.result.capital.maximumCommittedQuoteUnits, "1000000000000000000000");
  assert.equal(artifact.performance.realizedPnlQuoteUnits, null);
  assert.equal(artifact.performance.completedTradeCount, 0);
  assert.equal(gridQuantArtifact.safeParse(artifact).success, true);
});

test("refuses execution requests without exposing a trading path", () => {
  const input = gridFixture();
  input.task.capability = "execution";
  input.task.parameters.executionMode = "conditional-swaps";
  const artifact = analyzeGridQuant(input, NOW);
  assert.equal(artifact.status, "UNSUPPORTED_POSITION");
  assert.equal(artifact.reasonCode, "EXECUTION_NOT_AVAILABLE");
  assert.equal(artifact.result, null);
});

test("refuses non-allowlisted pools and token addresses", () => {
  const pool = gridFixture();
  pool.task.pair.pool = "0x2222222222222222222222222222222222222222";
  pool.snapshot.pair.pool = pool.task.pair.pool;
  assert.equal(analyzeGridQuant(pool, NOW).reasonCode, "PAIR_NOT_ALLOWLISTED");
  const token = gridFixture();
  token.task.pair.baseToken.address = "0x3333333333333333333333333333333333333333";
  token.snapshot.pair.baseToken.address = token.task.pair.baseToken.address;
  assert.equal(analyzeGridQuant(token, NOW).reasonCode, "PAIR_NOT_ALLOWLISTED");
});

test("refuses token metadata, decimals, and mechanics drift", () => {
  const metadata = gridFixture();
  metadata.task.pair.quoteToken.symbol = "USDC";
  metadata.snapshot.pair.quoteToken.symbol = "USDC";
  assert.equal(analyzeGridQuant(metadata, NOW).reasonCode, "TOKEN_METADATA_MISMATCH");
  const decimals = gridFixture();
  decimals.task.pair.quoteToken.decimals = 6;
  decimals.snapshot.pair.quoteToken.decimals = 6;
  assert.equal(analyzeGridQuant(decimals, NOW).reasonCode, "TOKEN_DECIMALS_MISMATCH");
  const mechanics = gridFixture();
  mechanics.task.pair.baseToken.mechanics = "fee_on_transfer";
  mechanics.snapshot.pair.baseToken.mechanics = "fee_on_transfer";
  assert.equal(analyzeGridQuant(mechanics, NOW).reasonCode, "TOKEN_MECHANICS_UNSUPPORTED");
});

test("refuses snapshot identity and permission mismatches", () => {
  const snapshot = gridFixture();
  snapshot.snapshot.snapshotId = "different";
  assert.equal(analyzeGridQuant(snapshot, NOW).reasonCode, "SNAPSHOT_TARGET_MISMATCH");
  const pair = gridFixture();
  pair.snapshot.pair.pool = "0x4444444444444444444444444444444444444444";
  assert.equal(analyzeGridQuant(pair, NOW).reasonCode, "SNAPSHOT_PAIR_MISMATCH");
  const authority = gridFixture();
  authority.snapshot.analysisAuthorized = false;
  assert.equal(analyzeGridQuant(authority, NOW).reasonCode, "AUTHORITY_MISMATCH");
});

test("fails stale, orphaned, and future snapshots closed", () => {
  const stale = gridFixture();
  stale.snapshot.capturedAtUtc = "2026-09-09T09:59:00.000Z";
  assert.equal(analyzeGridQuant(stale, NOW).status, "STALE_SNAPSHOT");
  const orphaned = gridFixture();
  orphaned.snapshot.canonicality = "orphaned";
  assert.equal(analyzeGridQuant(orphaned, NOW).status, "STALE_SNAPSHOT");
  const future = gridFixture();
  future.snapshot.gasEstimate!.estimatedAtUtc = "2026-09-09T10:00:20.000Z";
  assert.equal(analyzeGridQuant(future, NOW).status, "STALE_SNAPSHOT");
});

test("requires internally consistent pinned gas evidence", () => {
  const missing = gridFixture();
  missing.snapshot.gasEstimate = null;
  assert.equal(analyzeGridQuant(missing, NOW).reasonCode, "GAS_EVIDENCE_UNAVAILABLE");
  const mismatch = gridFixture();
  mismatch.snapshot.gasEstimate!.estimatedNetworkFeeQuoteUnitsPerSwap = "1";
  assert.equal(analyzeGridQuant(mismatch, NOW).reasonCode, "GAS_EVIDENCE_MISMATCH");
});

test("rejects unsafe capital, inventory, and spread plans", () => {
  const capital = gridFixture();
  capital.task.parameters.principalQuoteUnits = "1";
  assert.equal(analyzeGridQuant(capital, NOW).reasonCode, "INSUFFICIENT_CAPITAL");
  const inventory = gridFixture();
  inventory.task.parameters.maxBaseInventoryUnits = "1";
  assert.equal(analyzeGridQuant(inventory, NOW).reasonCode, "MAX_INVENTORY_EXCEEDED");
  const spread = gridFixture();
  spread.task.parameters.lowerPriceUnits = "10000";
  spread.task.parameters.upperPriceUnits = "10200";
  spread.task.parameters.gridCount = 3;
  spread.task.parameters.feeAssumptions = { buyFeeBps: 30, sellFeeBps: 30 };
  spread.task.parameters.slippageBps = 20;
  spread.task.parameters.maxBaseInventoryUnits = "100000000000000000000";
  assert.equal(analyzeGridQuant(spread, NOW).reasonCode, "FEES_OVERWHELM_SPREAD");
});

test("returns explicit no-action outcomes for expiry and cooldown", () => {
  const expired = gridFixture();
  expired.task.parameters.expiryUtc = NOW.toISOString();
  assert.equal(analyzeGridQuant(expired, NOW).status, "NO_ACTION");
  const cooling = gridFixture();
  cooling.snapshot.lastActionUtc = "2026-09-09T09:59:00.000Z";
  const artifact = analyzeGridQuant(cooling, NOW);
  assert.equal(artifact.reasonCode, "COOLDOWN_ACTIVE");
  assert.equal(artifact.result?.outcome, "NO_ACTION");
});

test("preserves signed JSON through the ERC-8183 claim sanitizer", () => {
  const raw = JSON.stringify(gridFixture());
  const encoded = encodeSignedTaskTransport(raw);
  assert.match(raw, /[\[\]]/);
  assert.ok(encoded.startsWith(SIGNED_TASK_TRANSPORT_PREFIX));
  assert.equal(sanitizeForClaim(encoded), encoded);
  const artifact = JSON.parse(analyzeGridQuantText(encoded, NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.taskId, "grid-1");
});

test("malformed transport and unknown fields fail closed", () => {
  const malformed = `${SIGNED_TASK_TRANSPORT_PREFIX}%%%`;
  const malformedArtifact = JSON.parse(analyzeGridQuantText(malformed, NOW)) as Record<string, unknown>;
  assert.equal(malformedArtifact.reasonCode, "INVALID_JSON");
  const unknown = { ...gridFixture(), trustedByBrowser: true };
  const unknownArtifact = JSON.parse(analyzeGridQuantText(JSON.stringify(unknown), NOW)) as Record<string, unknown>;
  assert.equal(unknownArtifact.reasonCode, "SCHEMA_VALIDATION_FAILED");
  assert.equal(unknownArtifact.evidence, null);
});
