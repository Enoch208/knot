import { healthGuardRequest, type HealthGuardRequest, type HealthMarket } from "./healthSchemas.js";

const E18 = 10n ** 18n;
const BPS = 10_000n;

type ArtifactStatus =
  | "ASSESSED"
  | "NO_DEBT"
  | "ASSESSMENT_INCOMPLETE"
  | "STALE_SNAPSHOT"
  | "UNSUPPORTED_POSITION"
  | "INVALID_REQUEST";

export interface HealthGuardArtifact {
  schemaVersion: "knot.health.artifact/1";
  category: "health";
  capability: "analysis";
  taskId: string | null;
  status: ArtifactStatus;
  reasonCode: string | null;
  assessedAtUtc: string;
  snapshot: { snapshotId: string; chainId: 56 | 97; blockNumber: string; blockHash: string } | null;
  protocol: { family: string; comptroller: string; status: string; forcedLiquidation: string } | null;
  positions: Array<Record<string, string | number | boolean | null>>;
  metrics: {
    collateralValueUsdE18: string | null;
    borrowingPowerCollateralUsdE18: string | null;
    liquidationThresholdCollateralUsdE18: string | null;
    debtValueUsdE18: string | null;
    healthRatioE18: string | null;
  };
  missingCoverage: string[];
  recommendation: "HOLD" | "REPAY" | "NONE" | "REFUSED";
  minimumEligibleAction: Record<string, string | boolean | null> | null;
  projectedPostAction: Record<string, string | null> | null;
  assumptions: string[];
  limitations: string[];
}

export function analyzeHealthGuardText(text: string, now = new Date()): string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, ["request is not valid JSON"]));
  }
  const parsed = healthGuardRequest.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
    return JSON.stringify(refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now, issues));
  }
  return JSON.stringify(analyzeHealthGuard(parsed.data, now));
}

export function analyzeHealthGuard(request: HealthGuardRequest, now = new Date()): HealthGuardArtifact {
  const { task, snapshot } = request;
  const base = artifactBase(request, now);
  const mismatches = targetMismatches(request);
  if (task.target.poolFamily !== "venus-core") {
    return { ...base, status: "UNSUPPORTED_POSITION", reasonCode: "UNSUPPORTED_POOL_FAMILY", missingCoverage: ["only venus-core is supported"], recommendation: "REFUSED" };
  }
  if (task.capability !== "analysis" || task.constraints.mode !== "notify") {
    return { ...base, status: "UNSUPPORTED_POSITION", reasonCode: "CAPABILITY_NOT_SUPPORTED", missingCoverage: ["HealthGuard currently delivers one-shot analysis only"], recommendation: "REFUSED" };
  }
  if (mismatches.length > 0) {
    return { ...base, status: "ASSESSMENT_INCOMPLETE", reasonCode: "SNAPSHOT_TARGET_MISMATCH", missingCoverage: mismatches, recommendation: "REFUSED" };
  }
  const staleReasons = freshnessFailures(request, now);
  if (staleReasons.length > 0) {
    return { ...base, status: "STALE_SNAPSHOT", reasonCode: "STALE_SNAPSHOT", missingCoverage: staleReasons, recommendation: "REFUSED" };
  }
  const coverageFailures = missingCoverage(request);
  const positions = snapshot.markets.map(positionRow);
  if (coverageFailures.length > 0) {
    return { ...base, positions, status: "ASSESSMENT_INCOMPLETE", reasonCode: "RESULT_INCOMPLETE", missingCoverage: coverageFailures, recommendation: "REFUSED" };
  }
  const totals = calculateTotals(request);
  const metrics = {
    collateralValueUsdE18: totals.collateral.toString(),
    borrowingPowerCollateralUsdE18: totals.borrowingPowerCollateral.toString(),
    liquidationThresholdCollateralUsdE18: totals.thresholdCollateral.toString(),
    debtValueUsdE18: totals.debt.toString(),
    healthRatioE18: totals.debt === 0n ? null : ((totals.thresholdCollateral * E18) / totals.debt).toString(),
  };
  if (totals.debt === 0n) {
    return { ...base, positions, metrics, status: "NO_DEBT", reasonCode: "NO_DEBT", recommendation: "NONE" };
  }
  const action = repaymentAction(request, totals.thresholdCollateral, totals.debt);
  const actionThreshold = ratioFraction(task.constraints.actionThresholdRatio);
  const needsAction = totals.thresholdCollateral * actionThreshold.denominator < totals.debt * actionThreshold.numerator;
  return {
    ...base,
    positions,
    metrics,
    status: "ASSESSED",
    reasonCode: null,
    recommendation: needsAction ? "REPAY" : "HOLD",
    minimumEligibleAction: needsAction ? action.minimum : null,
    projectedPostAction: needsAction ? action.projected : null,
  };
}

function artifactBase(request: HealthGuardRequest, now: Date): HealthGuardArtifact {
  const { task, snapshot } = request;
  return {
    schemaVersion: "knot.health.artifact/1",
    category: "health",
    capability: "analysis",
    taskId: task.taskId,
    status: "ASSESSMENT_INCOMPLETE",
    reasonCode: null,
    assessedAtUtc: now.toISOString(),
    snapshot: { snapshotId: snapshot.snapshotId, chainId: snapshot.chainId, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash },
    protocol: { family: snapshot.poolFamily, comptroller: snapshot.comptroller, status: snapshot.protocolStatus, forcedLiquidation: snapshot.forcedLiquidation },
    positions: [],
    metrics: { collateralValueUsdE18: null, borrowingPowerCollateralUsdE18: null, liquidationThresholdCollateralUsdE18: null, debtValueUsdE18: null, healthRatioE18: null },
    missingCoverage: [],
    recommendation: "REFUSED",
    minimumEligibleAction: null,
    projectedPostAction: null,
    assumptions: ["prices remain unchanged for projected repayment", "USD values use 18 decimal fixed-point units"],
    limitations: ["analysis only", "does not guarantee liquidation prevention", "does not execute repayment"],
  };
}

function refusal(status: ArtifactStatus, reasonCode: string, now: Date, missingCoverage: string[]): HealthGuardArtifact {
  return {
    schemaVersion: "knot.health.artifact/1", category: "health", capability: "analysis", taskId: null,
    status, reasonCode, assessedAtUtc: now.toISOString(), snapshot: null, protocol: null, positions: [],
    metrics: { collateralValueUsdE18: null, borrowingPowerCollateralUsdE18: null, liquidationThresholdCollateralUsdE18: null, debtValueUsdE18: null, healthRatioE18: null },
    missingCoverage, recommendation: "REFUSED", minimumEligibleAction: null, projectedPostAction: null,
    assumptions: ["no assessment is produced from invalid input"],
    limitations: ["analysis only", "invalid input was not assessed"],
  };
}

function targetMismatches({ task, snapshot }: HealthGuardRequest): string[] {
  const failures: string[] = [];
  if (task.snapshotId !== snapshot.snapshotId) failures.push("task snapshotId does not match snapshot");
  if (task.dataChainId !== snapshot.chainId) failures.push("task dataChainId does not match snapshot chainId");
  if (task.target.borrower !== snapshot.borrower) failures.push("task borrower does not match snapshot borrower");
  if (task.target.comptroller !== snapshot.comptroller) failures.push("task comptroller does not match snapshot comptroller");
  if (task.target.poolFamily !== snapshot.poolFamily) failures.push("task poolFamily does not match snapshot poolFamily");
  return failures;
}

function freshnessFailures({ snapshot, maxSnapshotAgeSeconds }: HealthGuardRequest, now: Date): string[] {
  const failures: string[] = [];
  if (snapshot.canonicality !== "confirmed") failures.push(`snapshot canonicality is ${snapshot.canonicality}`);
  if (ageSeconds(snapshot.capturedAtUtc, now) > maxSnapshotAgeSeconds) failures.push("snapshot exceeds maximum age");
  for (const market of snapshot.markets) {
    if (market.priceObservedAtUtc !== null && ageSeconds(market.priceObservedAtUtc, now) > maxSnapshotAgeSeconds) failures.push(`${market.symbol} price exceeds maximum age`);
  }
  return failures;
}

function ageSeconds(value: string, now: Date): number {
  return Math.abs(now.getTime() - new Date(value).getTime()) / 1000;
}

function missingCoverage({ snapshot }: HealthGuardRequest): string[] {
  const failures: string[] = [];
  if (!snapshot.debtInventoryComplete) failures.push("full debt inventory is not established");
  if (snapshot.protocolStatus === "unknown") failures.push("protocol status is unknown");
  if (snapshot.forcedLiquidation === "unknown") failures.push("forced-liquidation status is unknown");
  for (const market of snapshot.markets) {
    if (!market.supported) failures.push(`${market.symbol} market is unsupported`);
    if (
      market.oracleStatus !== "current" ||
      market.oraclePriceUsdE18 === null ||
      BigInt(market.oraclePriceUsdE18) === 0n ||
      market.priceObservedAtUtc === null
    ) failures.push(`${market.symbol} oracle coverage is unavailable`);
  }
  for (const debt of snapshot.specialDebts) {
    if (!debt.supported || debt.valueUsdE18 === null) failures.push(`${debt.kind} special debt is unsupported`);
  }
  return [...new Set(failures)];
}

function positionRow(market: HealthMarket): Record<string, string | number | boolean | null> {
  const price = market.oraclePriceUsdE18 === null ? null : BigInt(market.oraclePriceUsdE18);
  const collateral = price === null ? null : valueFloor(market.collateralUnits, market.decimals, price);
  const debt = price === null ? null : valueCeil(market.debtUnits, market.decimals, price);
  return {
    asset: market.asset, symbol: market.symbol, collateralUnits: market.collateralUnits, debtUnits: market.debtUnits,
    oraclePriceUsdE18: market.oraclePriceUsdE18, collateralValueUsdE18: collateral?.toString() ?? null,
    debtValueUsdE18: debt?.toString() ?? null, collateralFactorBps: market.collateralFactorBps,
    liquidationThresholdBps: market.liquidationThresholdBps,
    collateralEnabled: market.collateralEnabled, priceObservedAtUtc: market.priceObservedAtUtc,
  };
}

function calculateTotals({ snapshot }: HealthGuardRequest) {
  let collateral = 0n;
  let borrowingPowerCollateral = 0n;
  let thresholdCollateral = 0n;
  let debt = 0n;
  for (const market of snapshot.markets) {
    const price = BigInt(market.oraclePriceUsdE18 as string);
    const collateralValue = valueFloor(market.collateralUnits, market.decimals, price);
    const debtValue = valueCeil(market.debtUnits, market.decimals, price);
    collateral += collateralValue;
    if (market.collateralEnabled) borrowingPowerCollateral += (collateralValue * BigInt(market.collateralFactorBps)) / BPS;
    if (market.collateralEnabled) thresholdCollateral += (collateralValue * BigInt(market.liquidationThresholdBps)) / BPS;
    debt += debtValue;
  }
  for (const item of snapshot.specialDebts) debt += BigInt(item.valueUsdE18 as string);
  return { collateral, borrowingPowerCollateral, thresholdCollateral, debt };
}

function repaymentAction(request: HealthGuardRequest, thresholdCollateral: bigint, debt: bigint) {
  const target = ratioFraction(request.task.constraints.safetyThresholdRatio);
  const targetDebt = (thresholdCollateral * target.denominator) / target.numerator;
  const requiredValue = debt > targetDebt ? debt - targetDebt : 0n;
  const asset = request.snapshot.markets.find((market) => market.asset === request.task.constraints.repaymentAsset);
  if (!asset || asset.oraclePriceUsdE18 === null) {
    return {
      minimum: { available: false, reason: "repayment asset is not in the supported snapshot", asset: request.task.constraints.repaymentAsset, requiredUnits: null, withinMaximum: false },
      projected: null,
    };
  }
  const requiredUnits = divCeil(requiredValue * 10n ** BigInt(asset.decimals), BigInt(asset.oraclePriceUsdE18));
  const maxUnits = BigInt(request.task.constraints.maxRepaymentUnits);
  const withinMaximum = requiredUnits <= maxUnits;
  const appliedValue = valueFloor((requiredUnits < maxUnits ? requiredUnits : maxUnits).toString(), asset.decimals, BigInt(asset.oraclePriceUsdE18));
  const projectedDebt = debt > appliedValue ? debt - appliedValue : 0n;
  return {
    minimum: { available: request.snapshot.actionAvailable, reason: request.snapshot.actionAvailable ? null : "protocol action is unavailable", asset: asset.asset, requiredUnits: requiredUnits.toString(), withinMaximum },
    projected: { debtValueUsdE18: projectedDebt.toString(), healthRatioE18: projectedDebt === 0n ? null : ((thresholdCollateral * E18) / projectedDebt).toString() },
  };
}

function valueFloor(units: string, decimals: number, priceE18: bigint): bigint {
  return (BigInt(units) * priceE18) / 10n ** BigInt(decimals);
}

function valueCeil(units: string, decimals: number, priceE18: bigint): bigint {
  return divCeil(BigInt(units) * priceE18, 10n ** BigInt(decimals));
}

function divCeil(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function ratioFraction(value: number): { numerator: bigint; denominator: bigint } {
  const text = value.toString();
  if (!text.includes("e")) {
    const [whole, fraction = ""] = text.split(".");
    return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
  }
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const scale = exponent - fraction.length;
  return scale >= 0
    ? { numerator: digits * 10n ** BigInt(scale), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-scale) };
}
