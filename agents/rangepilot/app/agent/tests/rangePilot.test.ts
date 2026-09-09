import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForClaim } from "@bnbagent/sdk/erc8183";
import {
  COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX,
  SIGNED_TASK_TRANSPORT_PREFIX,
  analyzeRangePilot,
  analyzeRangePilotText,
  encodeCompressedSignedTaskTransport,
  encodeSignedTaskTransport,
} from "../src/rangePilot.js";
import { rangePilotArtifact } from "../src/rangeSchemas.js";
import { sqrtRatioAtTick } from "../src/rangeMath.js";
import { NOW, rangeFixture } from "./rangeFixture.js";

test("returns a typed hold without inventing historical performance", () => {
  const artifact = analyzeRangePilot(rangeFixture(), NOW);
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.reasonCode, "IN_RANGE_HOLD");
  assert.equal(artifact.decision, "HOLD");
  assert.equal(artifact.proposal, null);
  assert.ok(artifact.unavailableMetrics.includes("future yield"));
  assert.equal(rangePilotArtifact.safeParse(artifact).success, true);
});

test("proposes a tick-aligned bounded plan for an out-of-range position", () => {
  const input = rangeFixture();
  input.snapshot.pool.currentTick = 150;
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString();
  const artifact = analyzeRangePilot(input, NOW);
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.decision, "PROPOSE_RANGE");
  assert.deepEqual(
    [artifact.proposal?.tickLower, artifact.proposal?.tickUpper, artifact.proposal?.widthTicks],
    [50, 250, 200],
  );
  assert.equal(artifact.proposal?.checks.every((check) => check.passed), true);
});

test("refuses execution requests at the typed boundary", () => {
  const input = rangeFixture();
  input.task.capability = "execution";
  input.task.constraints.executionMode = "unattended";
  const artifact = analyzeRangePilot(input, NOW);
  assert.equal(artifact.status, "UNSUPPORTED_POSITION");
  assert.equal(artifact.reasonCode, "ANALYSIS_ONLY");
  assert.equal(artifact.decision, "REFUSED");
});

test("refuses analysis snapshots outside BSC mainnet", () => {
  const input = rangeFixture();
  input.task.chainId = 97;
  input.snapshot.chainId = 97;
  const artifact = analyzeRangePilot(input, NOW);
  assert.equal(artifact.status, "UNSUPPORTED_POSITION");
  assert.equal(artifact.reasonCode, "DATA_CHAIN_NOT_SUPPORTED");
});

test("fails stale and orphaned snapshots closed", () => {
  const stale = rangeFixture();
  stale.snapshot.capturedAtUtc = "2026-09-09T09:59:00.000Z";
  assert.equal(analyzeRangePilot(stale, NOW).status, "STALE_SNAPSHOT");
  const orphaned = rangeFixture();
  orphaned.snapshot.canonicality = "orphaned";
  assert.equal(analyzeRangePilot(orphaned, NOW).status, "STALE_SNAPSHOT");
});

test("refuses ownership, pool, and authority mismatches", () => {
  const owner = rangeFixture();
  owner.snapshot.position.owner = "0x7777777777777777777777777777777777777777";
  assert.equal(analyzeRangePilot(owner, NOW).reasonCode, "OWNER_MISMATCH");
  const pool = rangeFixture();
  pool.snapshot.pool.address = "0x8888888888888888888888888888888888888888";
  assert.equal(analyzeRangePilot(pool, NOW).reasonCode, "POOL_IDENTITY_MISMATCH");
  const authority = rangeFixture();
  authority.snapshot.account.canManagePosition = false;
  assert.equal(analyzeRangePilot(authority, NOW).reasonCode, "AUTHORITY_MISMATCH");
});

test("refuses unsafe pool and token configurations", () => {
  const farmed = rangeFixture();
  farmed.snapshot.position.farmed = true;
  assert.equal(analyzeRangePilot(farmed, NOW).reasonCode, "FARMED_POSITION_UNSUPPORTED");
  const hooked = rangeFixture();
  hooked.snapshot.pool.hasHooks = true;
  assert.equal(analyzeRangePilot(hooked, NOW).reasonCode, "HOOKS_UNSUPPORTED");
  const exotic = rangeFixture();
  exotic.task.allowedPool.token0.mechanics = "fee_on_transfer";
  exotic.snapshot.pool.token0.mechanics = "fee_on_transfer";
  assert.equal(analyzeRangePilot(exotic, NOW).reasonCode, "TOKEN_MECHANICS_UNSUPPORTED");
});

test("rejects a proposal that breaches budgets or lacks gas evidence", () => {
  const input = rangeFixture();
  input.snapshot.pool.currentTick = 150;
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString();
  input.task.constraints.token0BudgetUnits = "1";
  input.snapshot.gasEstimate = null;
  const artifact = analyzeRangePilot(input, NOW);
  assert.equal(artifact.status, "PLAN_REJECTED");
  assert.equal(artifact.decision, "REFUSED");
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "TOKEN0_BUDGET")?.passed, false);
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "GAS_BUDGET")?.passed, false);
});

test("preserves signed JSON through the ERC-8183 claim sanitizer", () => {
  const raw = JSON.stringify(rangeFixture());
  const encoded = encodeSignedTaskTransport(raw);
  assert.match(raw, /[\[\]]/);
  assert.ok(encoded.startsWith(SIGNED_TASK_TRANSPORT_PREFIX));
  assert.equal(sanitizeForClaim(encoded), encoded);
  const artifact = JSON.parse(analyzeRangePilotText(encoded, NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.taskId, "range-1");
});

test("bounded compression preserves a large signed request under the claim limit", () => {
  const raw = JSON.stringify(rangeFixture());
  const encoded = encodeCompressedSignedTaskTransport(raw);
  assert.ok(encoded.startsWith(COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX));
  assert.ok(encoded.length < encodeSignedTaskTransport(raw).length);
  assert.equal(sanitizeForClaim(encoded), encoded);
  const artifact = JSON.parse(analyzeRangePilotText(encoded, NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "ANALYZED");
  assert.equal(artifact.taskId, "range-1");
  const malformed = `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}eJw`;
  assert.equal(JSON.parse(analyzeRangePilotText(malformed, NOW)).reasonCode, "INVALID_JSON");
});

test("rejects oversized raw, encoded, and compressed task transports", () => {
  const oversized = "a".repeat(65_537);
  const encoded = `${SIGNED_TASK_TRANSPORT_PREFIX}${Buffer.from(oversized, "utf8").toString("base64url")}`;
  const compressed = `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}${"A".repeat(87_388)}`;
  assert.equal(JSON.parse(analyzeRangePilotText(oversized, NOW)).reasonCode, "INVALID_JSON");
  assert.equal(JSON.parse(analyzeRangePilotText(encoded, NOW)).reasonCode, "INVALID_JSON");
  assert.equal(JSON.parse(analyzeRangePilotText(compressed, NOW)).reasonCode, "INVALID_JSON");
});

test("malformed transport and unknown fields fail closed", () => {
  const malformed = `${SIGNED_TASK_TRANSPORT_PREFIX}%%%`;
  const malformedArtifact = JSON.parse(analyzeRangePilotText(malformed, NOW)) as Record<string, unknown>;
  assert.equal(malformedArtifact.reasonCode, "INVALID_JSON");
  const unknown = { ...rangeFixture(), trustedByBrowser: true };
  const unknownArtifact = JSON.parse(analyzeRangePilotText(JSON.stringify(unknown), NOW)) as Record<string, unknown>;
  assert.equal(unknownArtifact.reasonCode, "SCHEMA_VALIDATION_FAILED");
});
