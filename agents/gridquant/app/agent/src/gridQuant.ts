import { allocateUnits, arithmeticLevels, ceilDivide, geometricLevels, quoteToBaseUnits } from "./gridMath.js";
import { gridQuantArtifact, gridQuantRequest, type GridQuantArtifact, type GridQuantRequest } from "./gridSchemas.js";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const GRIDQUANT_PAIR = {
  chainId: 56,
  baseToken: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  baseSymbol: "WBNB",
  baseDecimals: 18,
  quoteToken: "0x55d398326f99059ff775485246999027b3197955",
  quoteSymbol: "USDT",
  quoteDecimals: 18,
  pool: "0x172fcd41e0913e95784454622d1c3724f546f849",
  poolFeeBpsPerSwap: 1,
} as const;
const FILL_POLICY = {
  executionModel: "OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS",
  ambiguousFill: "NO_FILL",
  sameSideRetrigger: "REFUSED",
  requiresObservedReceiptForFill: true,
} as const;
const PERFORMANCE = {
  realizedPnlQuoteUnits: null,
  openInventoryMarkToMarketQuoteUnits: null,
  completedTradeCount: 0,
  basis: "NO_OBSERVED_FILLS",
} as const;
const LIMITATIONS = [
  "analysis only; no order, swap, or liquidity transaction is signed",
  "historical performance and future return are unavailable",
  "a grid level is not a fill without an observed transaction receipt",
];
export const SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-base64url/1:";
export const COMPRESSED_SIGNED_TASK_TRANSPORT_PREFIX = "knot-json-deflate-base64url/1:";
const MAX_DECOMPRESSED_TASK_BYTES = 65_536;
const MAX_ENCODED_TASK_CHARS = Math.ceil(MAX_DECOMPRESSED_TASK_BYTES / 3) * 4;

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

export function analyzeGridQuantText(text: string, now = new Date()): string {
  const decoded = decodeSignedTaskTransport(text);
  if (decoded === null) return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now));
  let input: unknown;
  try {
    input = JSON.parse(decoded);
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now));
  }
  const parsed = gridQuantRequest.safeParse(input);
  if (!parsed.success) {
    return JSON.stringify(refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now));
  }
  return JSON.stringify(analyzeGridQuant(parsed.data, now));
}

export function analyzeGridQuant(request: GridQuantRequest, now = new Date()): GridQuantArtifact {
  const { task, snapshot } = request;
  const evidence = evidenceFrom(request);
  const timing = timingFrom(request, now);
  if (task.capability !== "analysis" || task.parameters.executionMode !== "analysis") {
    return refusal("UNSUPPORTED_POSITION", "EXECUTION_NOT_AVAILABLE", now, request);
  }
  if (task.snapshotId !== snapshot.snapshotId || task.dataChainId !== snapshot.chainId) {
    return refusal("UNSUPPORTED_POSITION", "SNAPSHOT_TARGET_MISMATCH", now, request);
  }
  if (task.requester !== snapshot.requester || !snapshot.analysisAuthorized) {
    return refusal("UNSUPPORTED_POSITION", "AUTHORITY_MISMATCH", now, request);
  }
  if (!samePair(task.pair, snapshot.pair)) {
    return refusal("UNSUPPORTED_POSITION", "SNAPSHOT_PAIR_MISMATCH", now, request);
  }
  if (!isAllowlistedAddresses(task.pair)) {
    return refusal("UNSUPPORTED_POSITION", "PAIR_NOT_ALLOWLISTED", now, request);
  }
  if (
    task.pair.baseToken.symbol !== GRIDQUANT_PAIR.baseSymbol ||
    task.pair.quoteToken.symbol !== GRIDQUANT_PAIR.quoteSymbol
  ) {
    return refusal("UNSUPPORTED_POSITION", "TOKEN_METADATA_MISMATCH", now, request);
  }
  if (
    task.pair.baseToken.decimals !== GRIDQUANT_PAIR.baseDecimals ||
    task.pair.quoteToken.decimals !== GRIDQUANT_PAIR.quoteDecimals
  ) {
    return refusal("UNSUPPORTED_POSITION", "TOKEN_DECIMALS_MISMATCH", now, request);
  }
  if (
    task.pair.baseToken.mechanics !== "plain_erc20" ||
    task.pair.quoteToken.mechanics !== "plain_erc20"
  ) {
    return refusal("UNSUPPORTED_POSITION", "TOKEN_MECHANICS_UNSUPPORTED", now, request);
  }
  if (!isFresh(request, now)) {
    return refusal("STALE_SNAPSHOT", "STALE_SNAPSHOT", now, request);
  }
  if (snapshot.gasEstimate === null) {
    return refusal("PLAN_REJECTED", "GAS_EVIDENCE_UNAVAILABLE", now, request);
  }
  const expectedGasCost =
    (BigInt(snapshot.gasEstimate.gasUnits) *
      BigInt(snapshot.gasEstimate.gasPriceWei) *
      BigInt(snapshot.gasEstimate.nativeTokenPriceQuoteUnits)) /
    10n ** 18n;
  if (expectedGasCost.toString() !== snapshot.gasEstimate.estimatedNetworkFeeQuoteUnitsPerSwap) {
    return refusal("PLAN_REJECTED", "GAS_EVIDENCE_MISMATCH", now, request);
  }
  const parameters = task.parameters;
  if (
    parameters.feeAssumptions.buyFeeBps < GRIDQUANT_PAIR.poolFeeBpsPerSwap ||
    parameters.feeAssumptions.sellFeeBps < GRIDQUANT_PAIR.poolFeeBpsPerSwap
  ) {
    return refusal("PLAN_REJECTED", "FEE_ASSUMPTION_UNDERSTATED", now, request);
  }
  const lower = BigInt(parameters.lowerPriceUnits);
  const upper = BigInt(parameters.upperPriceUnits);
  if (lower === 0n || lower >= upper) {
    return refusal("PLAN_REJECTED", "INVERTED_BOUNDS", now, request);
  }
  if (parameters.gridCount < 2 || parameters.gridCount > 100) {
    return refusal("PLAN_REJECTED", "INVALID_GRID_COUNT", now, request);
  }
  const principal = BigInt(parameters.principalQuoteUnits);
  const floor = BigInt(parameters.orderSizeFloorQuoteUnits);
  const allocations = allocateUnits(principal, parameters.gridCount);
  if (principal === 0n || allocations.some((allocation) => allocation < floor || allocation === 0n)) {
    return refusal("PLAN_REJECTED", "INSUFFICIENT_CAPITAL", now, request);
  }
  const levels = parameters.spacing === "arithmetic"
    ? arithmeticLevels(lower, upper, parameters.gridCount)
    : geometricLevels(lower, upper, parameters.gridCount);
  if (new Set(levels.map(String)).size !== levels.length) {
    return refusal("PLAN_REJECTED", "DUPLICATE_LEVELS", now, request);
  }
  const baseAmounts = levels.map((price, index) =>
    quoteToBaseUnits(
      allocations[index] ?? 0n,
      price,
      parameters.priceDecimals,
      GRIDQUANT_PAIR.baseDecimals,
      GRIDQUANT_PAIR.quoteDecimals,
    ),
  );
  if (baseAmounts.some((amount) => amount === 0n)) {
    return refusal("PLAN_REJECTED", "ZERO_BASE_AMOUNT", now, request);
  }
  const maximumBaseInventory = baseAmounts.reduce((sum, amount) => sum + amount, 0n);
  if (maximumBaseInventory > BigInt(parameters.maxBaseInventoryUnits)) {
    return refusal("PLAN_REJECTED", "MAX_INVENTORY_EXCEEDED", now, request);
  }
  const variableCostBps = BigInt(
    parameters.feeAssumptions.buyFeeBps +
      parameters.feeAssumptions.sellFeeBps +
      2 * parameters.slippageBps,
  );
  const roundTripNetworkFee =
    BigInt(snapshot.gasEstimate.estimatedNetworkFeeQuoteUnitsPerSwap) * 2n;
  const smallestAllocation = allocations.reduce((smallest, allocation) =>
    allocation < smallest ? allocation : smallest,
  );
  const fixedCostBps = ceilDivide(roundTripNetworkFee * 10_000n, smallestAllocation);
  const breakEvenBps = variableCostBps + fixedCostBps;
  const adjacentSpreads = levels.slice(0, -1).map((price, index) => ({
    low: price,
    high: levels[index + 1] ?? price,
  }));
  const firstSpread = adjacentSpreads[0] ?? { low: lower, high: upper };
  const minimumGrossSpreadBps = adjacentSpreads.reduce((minimum, spread) => {
    const candidate = ((spread.high - spread.low) * 10_000n) / spread.low;
    return candidate < minimum ? candidate : minimum;
  }, ((firstSpread.high - firstSpread.low) * 10_000n) / firstSpread.low);
  if (adjacentSpreads.some((spread) =>
    (spread.high - spread.low) * 10_000n <= spread.low * breakEvenBps
  )) {
    return refusal("PLAN_REJECTED", "FEES_OVERWHELM_SPREAD", now, request);
  }
  if (Date.parse(parameters.expiryUtc) <= now.getTime()) {
    return artifact("NO_ACTION", "EXPIRED", now, task.taskId, evidence, timing, {
      outcome: "NO_ACTION",
      reason: "EXPIRED",
      remainingCooldownSeconds: 0,
    });
  }
  const lastAction = snapshot.lastActionUtc === null ? null : Date.parse(snapshot.lastActionUtc);
  const remainingCooldownSeconds = lastAction === null
    ? 0
    : Math.max(0, Math.ceil((lastAction + parameters.cooldownSeconds * 1_000 - now.getTime()) / 1_000));
  if (remainingCooldownSeconds > 0) {
    return artifact("NO_ACTION", "COOLDOWN_ACTIVE", now, task.taskId, evidence, timing, {
      outcome: "NO_ACTION",
      reason: "COOLDOWN_ACTIVE",
      remainingCooldownSeconds,
    });
  }
  return artifact("ANALYZED", "PLAN", now, task.taskId, evidence, timing, {
    outcome: "PLAN",
    pairId: "bsc:WBNB/USDT:pancakeswap-v3",
    spacing: parameters.spacing,
    levels: levels.map((price, index) => ({
      index,
      priceUnits: price.toString(),
      priceDecimals: parameters.priceDecimals,
      allocatedQuoteUnits: (allocations[index] ?? 0n).toString(),
      estimatedBaseUnits: (baseAmounts[index] ?? 0n).toString(),
      amountRounding: "DOWN" as const,
    })),
    capital: {
      principalQuoteUnits: parameters.principalQuoteUnits,
      maximumCommittedQuoteUnits: allocations.reduce((sum, amount) => sum + amount, 0n).toString(),
      maximumBaseInventoryUnits: maximumBaseInventory.toString(),
      baseInventoryLimitUnits: parameters.maxBaseInventoryUnits,
    },
    fees: {
      buyFeeBps: parameters.feeAssumptions.buyFeeBps,
      sellFeeBps: parameters.feeAssumptions.sellFeeBps,
      slippageBpsPerSwap: parameters.slippageBps,
      estimatedRoundTripNetworkFeeQuoteUnits: roundTripNetworkFee.toString(),
      minimumGrossAdjacentSpreadBpsFloor: minimumGrossSpreadBps.toString(),
      conservativeBreakEvenBps: breakEvenBps.toString(),
    },
    parameterChecks: [
      "SUPPORTED_PAIR",
      "SUPPORTED_DECIMALS",
      "ANALYSIS_ONLY",
      "PINNED_SNAPSHOT",
      "AUTHORIZED_ANALYSIS",
      "ORDERED_BOUNDS",
      "GRID_COUNT",
      "UNIQUE_LEVELS",
      "CAPITAL_CONSERVED",
      "INVENTORY_EXPOSURE",
      "FEES_BELOW_SPREAD",
      "COOLDOWN_ELAPSED",
    ],
  });
}

function isAllowlistedAddresses(pair: GridQuantRequest["task"]["pair"]): boolean {
  return pair.chainId === 56 &&
    pair.baseToken.address === GRIDQUANT_PAIR.baseToken &&
    pair.quoteToken.address === GRIDQUANT_PAIR.quoteToken &&
    pair.pool === GRIDQUANT_PAIR.pool;
}

function samePair(
  left: GridQuantRequest["task"]["pair"],
  right: GridQuantRequest["snapshot"]["pair"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFresh({ snapshot, maxSnapshotAgeSeconds }: GridQuantRequest, now: Date): boolean {
  if (snapshot.canonicality !== "confirmed") return false;
  const capturedAt = Date.parse(snapshot.capturedAtUtc);
  const blockAt = Date.parse(snapshot.blockTimestampUtc);
  if (capturedAt < blockAt || capturedAt > now.getTime()) return false;
  if (now.getTime() - capturedAt > maxSnapshotAgeSeconds * 1_000) return false;
  if (snapshot.gasEstimate !== null) {
    const estimatedAt = Date.parse(snapshot.gasEstimate.estimatedAtUtc);
    if (estimatedAt > now.getTime() || now.getTime() - estimatedAt > maxSnapshotAgeSeconds * 1_000) return false;
  }
  return true;
}

function evidenceFrom({ snapshot }: GridQuantRequest) {
  return {
    snapshotId: snapshot.snapshotId,
    chainId: snapshot.chainId,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    blockTimestampUtc: snapshot.blockTimestampUtc,
    capturedAtUtc: snapshot.capturedAtUtc,
    gasEstimatedAtUtc: snapshot.gasEstimate?.estimatedAtUtc ?? null,
    sources: snapshot.sources.map((source) => source.uri),
  };
}

function timingFrom({ task, snapshot }: GridQuantRequest, now: Date) {
  return {
    evaluatedAtUtc: now.toISOString(),
    expiryUtc: task.parameters.expiryUtc,
    cooldownSeconds: task.parameters.cooldownSeconds,
    lastActionUtc: snapshot.lastActionUtc,
  };
}

function artifact(
  status: GridQuantArtifact["status"],
  reasonCode: string,
  now: Date,
  taskId: string,
  evidence: NonNullable<GridQuantArtifact["evidence"]>,
  timing: NonNullable<GridQuantArtifact["timing"]>,
  result: NonNullable<GridQuantArtifact["result"]>,
): GridQuantArtifact {
  return gridQuantArtifact.parse({
    schemaVersion: "knot.gridquant.artifact/1",
    category: "grid",
    capability: "analysis",
    taskId,
    status,
    reasonCode,
    assessedAtUtc: now.toISOString(),
    evidence,
    timing,
    result,
    fillPolicy: FILL_POLICY,
    historicalEvaluation: null,
    performance: PERFORMANCE,
    limitations: LIMITATIONS,
  });
}

function refusal(
  status: GridQuantArtifact["status"],
  reasonCode: string,
  now: Date,
  request?: GridQuantRequest,
): GridQuantArtifact {
  return gridQuantArtifact.parse({
    schemaVersion: "knot.gridquant.artifact/1",
    category: "grid",
    capability: "analysis",
    taskId: request?.task.taskId ?? null,
    status,
    reasonCode,
    assessedAtUtc: now.toISOString(),
    evidence: request ? evidenceFrom(request) : null,
    timing: request ? timingFrom(request, now) : null,
    result: null,
    fillPolicy: FILL_POLICY,
    historicalEvaluation: null,
    performance: PERFORMANCE,
    limitations: LIMITATIONS,
  });
}
