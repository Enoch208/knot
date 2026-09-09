import {
  rangePilotArtifact,
  rangePilotRequest,
  type RangePilotArtifact,
  type RangePilotPlanCheck,
  type RangePilotRequest,
} from "./rangeSchemas.js";
import {
  alignedCeil,
  alignedFloor,
  amountsForLiquidity,
  MAX_TICK,
  MIN_TICK,
  sqrtRatioAtTick,
} from "./rangeMath.js";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const BASE_ASSUMPTIONS = [
  "all position, pool, price, liquidity, ownership, and balance fields share the identified block",
  "proposal amounts preserve current position liquidity and use conservative token0 rounding",
  "no future return or narrower-range yield advantage is inferred",
];
const UNAVAILABLE = ["realized fees", "historical time in range", "future yield", "swap price impact"];
export const SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-base64url/1:";
export const COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-deflate-base64url/1:";
const MAX_DECOMPRESSED_TASK_BYTES = 65_536;

export function encodeSignedTaskTransport(text: string): string {
  return `${SIGNED_TASK_TRANSPORT_PREFIX}${Buffer.from(text, "utf8").toString("base64url")}`;
}

export function encodeCompressedSignedTaskTransport(text: string): string {
  return `${COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX}${deflateRawSync(Buffer.from(text, "utf8")).toString("base64url")}`;
}

export function decodeSignedTaskTransport(text: string): string | null {
  const compressed = text.startsWith(COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX);
  if (!compressed && !text.startsWith(SIGNED_TASK_TRANSPORT_PREFIX)) return text;
  const prefix = compressed ? COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX : SIGNED_TASK_TRANSPORT_PREFIX;
  const payload = text.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return null;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const decoded = compressed ? inflateRawSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_TASK_BYTES }) : bytes;
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}

export function analyzeRangePilotText(text: string, now = new Date()): string {
  const decoded = decodeSignedTaskTransport(text);
  if (decoded === null) return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null));
  let input: unknown;
  try {
    input = JSON.parse(decoded);
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null));
  }
  const parsed = rangePilotRequest.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify(refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now, null));
  }
  return JSON.stringify(analyzeRangePilot(parsed.data, now));
}

export function analyzeRangePilot(request: RangePilotRequest, now = new Date()): RangePilotArtifact {
  const { task, snapshot } = request;
  const evidence = evidenceFrom(request);
  if (task.capability !== "analysis" || task.constraints.executionMode !== "analysis") {
    return refusal("UNSUPPORTED_POSITION", "ANALYSIS_ONLY", now, evidence, task.taskId);
  }
  if (task.chainId !== 56 || snapshot.chainId !== 56) {
    return refusal("UNSUPPORTED_POSITION", "DATA_CHAIN_NOT_SUPPORTED", now, evidence, task.taskId);
  }
  const identityFailure = identityFailureCode(request);
  if (identityFailure !== null) {
    return refusal("UNSUPPORTED_POSITION", identityFailure, now, evidence, task.taskId);
  }
  const stateFailure = stateFailureCode(request);
  if (stateFailure !== null) {
    return refusal("UNSUPPORTED_POSITION", stateFailure, now, evidence, task.taskId);
  }
  if (!isFresh(request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_SNAPSHOT", now, evidence, task.taskId);
  }
  const liquidity = BigInt(snapshot.position.liquidity);
  const currentAmounts = amountsForLiquidity(
    liquidity,
    BigInt(snapshot.pool.sqrtPriceX96),
    snapshot.position.tickLower,
    snapshot.position.tickUpper,
  );
  const condition =
    snapshot.pool.currentTick >= snapshot.position.tickLower &&
    snapshot.pool.currentTick < snapshot.position.tickUpper
      ? "IN_RANGE"
      : "OUT_OF_RANGE";
  const currentState = {
    owner: snapshot.position.owner,
    pool: snapshot.pool.address,
    token0: tokenWithoutBalance(snapshot.pool.token0),
    token1: tokenWithoutBalance(snapshot.pool.token1),
    currentTick: snapshot.pool.currentTick,
    tickLower: snapshot.position.tickLower,
    tickUpper: snapshot.position.tickUpper,
    tickSpacing: snapshot.pool.tickSpacing,
    liquidity: snapshot.position.liquidity,
    activeLiquidity: snapshot.pool.activeLiquidity,
    amount0Units: currentAmounts.amount0.toString(),
    amount1Units: currentAmounts.amount1.toString(),
    tokensOwed0: snapshot.position.tokensOwed0,
    tokensOwed1: snapshot.position.tokensOwed1,
    condition,
  } as const;
  if (condition === "IN_RANGE") {
    return parseArtifact({
      ...base(task.taskId, "ANALYZED", "IN_RANGE_HOLD", now, evidence),
      currentState,
      decision: "HOLD",
      proposal: null,
    });
  }
  const bounds = proposalBounds(request);
  const proposedAmounts = amountsForLiquidity(
    liquidity,
    BigInt(snapshot.pool.sqrtPriceX96),
    bounds.lower,
    bounds.upper,
  );
  const available0 =
    BigInt(snapshot.pool.token0.balanceUnits) +
    currentAmounts.amount0 +
    BigInt(snapshot.position.tokensOwed0);
  const available1 =
    BigInt(snapshot.pool.token1.balanceUnits) +
    currentAmounts.amount1 +
    BigInt(snapshot.position.tokensOwed1);
  const gasEstimate =
    snapshot.gasEstimate === null
      ? null
      : BigInt(snapshot.gasEstimate.gasUnits) * BigInt(snapshot.gasEstimate.gasPriceWei);
  const checks = buildChecks(request, bounds, proposedAmounts, available0, available1, gasEstimate, now);
  const eligible = checks.every((check) => check.passed);
  const cooldownOnly =
    !eligible && checks.filter((check) => !check.passed).every((check) => check.code === "COOLDOWN");
  return parseArtifact({
    ...base(
      task.taskId,
      eligible || cooldownOnly ? "ANALYZED" : "PLAN_REJECTED",
      eligible ? "OUT_OF_RANGE" : cooldownOnly ? "COOLDOWN_ACTIVE" : "PLAN_CONSTRAINTS_FAILED",
      now,
      evidence,
    ),
    currentState,
    decision: eligible ? "PROPOSE_RANGE" : cooldownOnly ? "HOLD" : "REFUSED",
    proposal: {
      tickLower: bounds.lower,
      tickUpper: bounds.upper,
      widthTicks: bounds.upper - bounds.lower,
      liquidity: snapshot.position.liquidity,
      amount0Units: proposedAmounts.amount0.toString(),
      amount1Units: proposedAmounts.amount1.toString(),
      maximumSlippageBps: task.constraints.maximumSlippageBps,
      gasEstimateWei: gasEstimate?.toString() ?? null,
      eligible,
      checks,
    },
  });
}

function identityFailureCode({ task, snapshot }: RangePilotRequest): string | null {
  const allowed = task.allowedPool;
  const pool = snapshot.pool;
  const position = snapshot.position;
  if (task.snapshotId !== snapshot.snapshotId || task.chainId !== snapshot.chainId) return "SNAPSHOT_TARGET_MISMATCH";
  if (task.positionManager !== snapshot.positionManager || task.positionTokenId !== snapshot.positionTokenId) return "POSITION_IDENTITY_MISMATCH";
  if (position.owner !== task.controllingAccount || snapshot.account.address !== task.controllingAccount) return "OWNER_MISMATCH";
  if (!snapshot.account.canManagePosition) return "AUTHORITY_MISMATCH";
  if (position.pool !== pool.address || pool.address !== allowed.address || pool.factory !== allowed.factory) return "POOL_IDENTITY_MISMATCH";
  if (position.token0 !== pool.token0.address || pool.token0.address !== allowed.token0.address) return "TOKEN0_IDENTITY_MISMATCH";
  if (position.token1 !== pool.token1.address || pool.token1.address !== allowed.token1.address) return "TOKEN1_IDENTITY_MISMATCH";
  if (pool.token0.decimals !== allowed.token0.decimals || pool.token1.decimals !== allowed.token1.decimals) return "TOKEN_DECIMALS_MISMATCH";
  if (pool.token0.symbol !== allowed.token0.symbol || pool.token1.symbol !== allowed.token1.symbol) return "TOKEN_METADATA_MISMATCH";
  if (pool.token0.mechanics !== allowed.token0.mechanics || pool.token1.mechanics !== allowed.token1.mechanics) return "TOKEN_CONFIGURATION_MISMATCH";
  if (position.feeTier !== pool.feeTier || pool.feeTier !== allowed.feeTier || pool.tickSpacing !== allowed.tickSpacing) return "POOL_CONFIGURATION_MISMATCH";
  return null;
}

function stateFailureCode({ task, snapshot }: RangePilotRequest): string | null {
  const { position, pool } = snapshot;
  if (!pool.initialized) return "POOL_NOT_INITIALIZED";
  if (position.farmed) return "FARMED_POSITION_UNSUPPORTED";
  if (pool.hasHooks) return "HOOKS_UNSUPPORTED";
  if (pool.token0.mechanics !== "plain_erc20" || pool.token1.mechanics !== "plain_erc20") return "TOKEN_MECHANICS_UNSUPPORTED";
  if (BigInt(position.liquidity) === 0n) return "EMPTY_POSITION";
  if (BigInt(pool.activeLiquidity) === 0n || BigInt(pool.sqrtPriceX96) === 0n) return "POOL_STATE_INVALID";
  if (position.tickLower >= position.tickUpper) return "POSITION_TICKS_INVALID";
  if (position.tickLower % pool.tickSpacing !== 0 || position.tickUpper % pool.tickSpacing !== 0) return "POSITION_TICKS_UNALIGNED";
  if (position.tickLower < task.allowedPool.minimumTick || position.tickUpper > task.allowedPool.maximumTick) return "POSITION_TICKS_OUT_OF_BOUNDS";
  const sqrtPrice = BigInt(pool.sqrtPriceX96);
  if (pool.currentTick >= task.allowedPool.maximumTick) return "POOL_TICK_OUT_OF_BOUNDS";
  if (sqrtPrice < sqrtRatioAtTick(pool.currentTick) || sqrtPrice >= sqrtRatioAtTick(pool.currentTick + 1)) return "POOL_PRICE_TICK_MISMATCH";
  return null;
}

function isFresh({ snapshot, maxSnapshotAgeSeconds }: RangePilotRequest, now: Date): boolean {
  if (snapshot.canonicality !== "confirmed") return false;
  const captured = new Date(snapshot.capturedAtUtc).getTime();
  const block = new Date(snapshot.blockTimestampUtc).getTime();
  if (captured < block || captured > now.getTime()) return false;
  if (now.getTime() - captured > maxSnapshotAgeSeconds * 1_000) return false;
  if (snapshot.gasEstimate !== null) {
    const estimated = new Date(snapshot.gasEstimate.estimatedAtUtc).getTime();
    if (estimated > now.getTime() || now.getTime() - estimated > maxSnapshotAgeSeconds * 1_000) return false;
  }
  return true;
}

function proposalBounds({ task, snapshot }: RangePilotRequest): { lower: number; upper: number } {
  const spacing = snapshot.pool.tickSpacing;
  const requestedIntervals = Math.max(2, Math.ceil(task.constraints.targetRangeWidthTicks / spacing));
  const center = alignedFloor(snapshot.pool.currentTick, spacing);
  const lowerIntervals = Math.floor(requestedIntervals / 2);
  const upperIntervals = requestedIntervals - lowerIntervals;
  const minimum = alignedCeil(Math.max(MIN_TICK, task.allowedPool.minimumTick), spacing);
  const maximum = alignedFloor(Math.min(MAX_TICK, task.allowedPool.maximumTick), spacing);
  let lower = center - lowerIntervals * spacing;
  let upper = center + upperIntervals * spacing;
  if (lower < minimum) {
    upper += minimum - lower;
    lower = minimum;
  }
  if (upper > maximum) {
    lower -= upper - maximum;
    upper = maximum;
  }
  if (lower < minimum) lower = minimum;
  return { lower, upper };
}

function buildChecks(
  request: RangePilotRequest,
  bounds: { lower: number; upper: number },
  amounts: { amount0: bigint; amount1: bigint },
  available0: bigint,
  available1: bigint,
  gasEstimate: bigint | null,
  now: Date,
): RangePilotPlanCheck[] {
  const { task, snapshot } = request;
  const width = bounds.upper - bounds.lower;
  const cooldownEnds = snapshot.lastCompletedActionAtUtc === null
    ? null
    : new Date(snapshot.lastCompletedActionAtUtc).getTime() + task.constraints.cooldownSeconds * 1_000;
  const cooldownPassed = cooldownEnds === null || cooldownEnds <= now.getTime();
  const tickPassed = bounds.lower < bounds.upper && bounds.lower >= task.allowedPool.minimumTick && bounds.upper <= task.allowedPool.maximumTick && width >= task.constraints.minimumRangeWidthTicks && width <= task.constraints.maximumRangeWidthTicks;
  return [
    check("TICK_BOUNDS", tickPassed, `${bounds.lower}:${bounds.upper}:${width}`, `${task.allowedPool.minimumTick}:${task.allowedPool.maximumTick}:${task.constraints.minimumRangeWidthTicks}:${task.constraints.maximumRangeWidthTicks}`),
    check("TOKEN0_BUDGET", amounts.amount0 <= BigInt(task.constraints.token0BudgetUnits), amounts.amount0.toString(), task.constraints.token0BudgetUnits),
    check("TOKEN1_BUDGET", amounts.amount1 <= BigInt(task.constraints.token1BudgetUnits), amounts.amount1.toString(), task.constraints.token1BudgetUnits),
    check("TOKEN0_AVAILABLE", amounts.amount0 <= available0, amounts.amount0.toString(), available0.toString()),
    check("TOKEN1_AVAILABLE", amounts.amount1 <= available1, amounts.amount1.toString(), available1.toString()),
    check("SLIPPAGE_BOUND", task.constraints.maximumSlippageBps <= task.allowedPool.maximumSlippageBps, task.constraints.maximumSlippageBps.toString(), task.allowedPool.maximumSlippageBps.toString()),
    check("GAS_BUDGET", gasEstimate !== null && gasEstimate <= BigInt(task.constraints.gasBudgetWei), gasEstimate?.toString() ?? "unavailable", task.constraints.gasBudgetWei),
    check("COOLDOWN", cooldownPassed, cooldownEnds === null ? "no prior action" : new Date(cooldownEnds).toISOString(), now.toISOString()),
  ];
}

function check(code: RangePilotPlanCheck["code"], passed: boolean, observed: string, limit: string): RangePilotPlanCheck {
  return { code, passed, observed, limit };
}

function evidenceFrom({ snapshot }: RangePilotRequest): NonNullable<RangePilotArtifact["evidence"]> {
  return {
    snapshotId: snapshot.snapshotId,
    chainId: snapshot.chainId,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    blockTimestampUtc: snapshot.blockTimestampUtc,
    capturedAtUtc: snapshot.capturedAtUtc,
    gasEstimatedAtUtc: snapshot.gasEstimate?.estimatedAtUtc ?? null,
  };
}

function tokenWithoutBalance(token: RangePilotRequest["snapshot"]["pool"]["token0"]) {
  return { address: token.address, symbol: token.symbol, decimals: token.decimals, mechanics: token.mechanics };
}

function base(taskId: string, status: RangePilotArtifact["status"], reasonCode: string, now: Date, evidence: RangePilotArtifact["evidence"]) {
  return { schemaVersion: "knot.rangepilot.artifact/1" as const, category: "rebalancing" as const, capability: "analysis" as const, taskId, status, reasonCode, assessedAtUtc: now.toISOString(), evidence, assumptions: BASE_ASSUMPTIONS, unavailableMetrics: UNAVAILABLE };
}

function refusal(status: RangePilotArtifact["status"], reasonCode: string, now: Date, evidence: RangePilotArtifact["evidence"], taskId: string | null = null): RangePilotArtifact {
  return parseArtifact({ ...base(taskId ?? "invalid", status, reasonCode, now, evidence), taskId, currentState: null, decision: "REFUSED", proposal: null });
}

function parseArtifact(value: unknown): RangePilotArtifact {
  return rangePilotArtifact.parse(value);
}
