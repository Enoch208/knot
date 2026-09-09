import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHealthGuard, analyzeHealthGuardText } from "../src/healthGuard.js";
import { healthFixture as fixture, NOW } from "./healthFixture.js";

test("returns a typed solvent assessment with labeled metrics", () => {
  const artifact = analyzeHealthGuard(fixture(), NOW);
  assert.equal(artifact.status, "ASSESSED");
  assert.equal(artifact.recommendation, "HOLD");
  assert.equal(artifact.metrics.collateralValueUsdE18, "200000000000000000000");
  assert.equal(artifact.metrics.borrowingPowerCollateralUsdE18, "150000000000000000000");
  assert.equal(artifact.metrics.liquidationThresholdCollateralUsdE18, "160000000000000000000");
  assert.equal(artifact.metrics.debtValueUsdE18, "100000000000000000000");
  assert.equal(artifact.metrics.healthRatioE18, "1600000000000000000");
});

test("returns NO_DEBT without an infinite health ratio", () => {
  const input = fixture();
  input.snapshot.markets[1].debtUnits = "0";
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "NO_DEBT");
  assert.equal(artifact.metrics.healthRatioE18, null);
  assert.equal(artifact.recommendation, "NONE");
});

test("does not infer NO_DEBT from an incomplete inventory", () => {
  const input = fixture();
  input.snapshot.markets[1].debtUnits = "0";
  input.snapshot.debtInventoryComplete = false;
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "ASSESSMENT_INCOMPLETE");
  assert.match(artifact.missingCoverage.join(" "), /full debt inventory/);
});

test("refuses unsupported special debt as assessment incomplete", () => {
  const input = fixture();
  input.snapshot.specialDebts.push({ kind: "VAI", valueUsdE18: null, supported: false });
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "ASSESSMENT_INCOMPLETE");
  assert.match(artifact.missingCoverage.join(" "), /VAI special debt/);
});

test("refuses stale snapshots and prices", () => {
  const input = fixture();
  input.snapshot.capturedAtUtc = "2026-09-09T09:59:00.000Z";
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "STALE_SNAPSHOT");
  assert.equal(artifact.recommendation, "REFUSED");
});

test("oracle failure produces unknown risk rather than a safe result", () => {
  const input = fixture();
  input.snapshot.markets[1].oracleStatus = "unavailable";
  input.snapshot.markets[1].oraclePriceUsdE18 = null;
  input.snapshot.markets[1].priceObservedAtUtc = null;
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "ASSESSMENT_INCOMPLETE");
  assert.equal(artifact.metrics.healthRatioE18, null);
});

test("execution requests are refused by the analysis-only service", () => {
  const input = fixture();
  input.task.capability = "execution";
  input.task.executionChainId = 56;
  input.task.constraints.mode = "execute";
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "UNSUPPORTED_POSITION");
  assert.equal(artifact.reasonCode, "CAPABILITY_NOT_SUPPORTED");
});

test("zero-valued current oracle data fails closed", () => {
  const input = fixture();
  input.snapshot.markets[1].oraclePriceUsdE18 = "0";
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.status, "ASSESSMENT_INCOMPLETE");
  assert.equal(artifact.metrics.healthRatioE18, null);
});

test("near-threshold debt returns the conservative minimum repayment", () => {
  const input = fixture();
  input.snapshot.markets[1].debtUnits = "120000000000000000000";
  const artifact = analyzeHealthGuard(input, NOW);
  assert.equal(artifact.recommendation, "REPAY");
  assert.equal(artifact.minimumEligibleAction?.requiredUnits, "13333333333333333334");
  assert.equal(artifact.minimumEligibleAction?.withinMaximum, true);
});

test("the text path is deterministic for a fixed assessment time", () => {
  const input = JSON.stringify(fixture());
  assert.equal(analyzeHealthGuardText(input, NOW), analyzeHealthGuardText(input, NOW));
});

test("unknown request fields fail the closed schema", () => {
  const input = { ...fixture(), hiddenDebtIsZero: true };
  const artifact = JSON.parse(analyzeHealthGuardText(JSON.stringify(input), NOW)) as Record<string, unknown>;
  assert.equal(artifact.status, "INVALID_REQUEST");
  assert.equal(artifact.reasonCode, "SCHEMA_VALIDATION_FAILED");
});
