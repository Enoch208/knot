import { createHash } from "node:crypto"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import type { EvidenceResolver } from "../../packages/advantage/src/runner.ts"
import {
  pairedExperimentInput,
  type EvidenceReference,
  type PairedExperimentInput,
} from "../../packages/advantage/src/schemas.ts"

const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const C = "0x3333333333333333333333333333333333333333"
const REGISTRY = "0x4444444444444444444444444444444444444444"
const ZERO_HASH = `0x${"0".repeat(64)}`
const ONE_HASH = `0x${"1".repeat(64)}`
const OBSERVED_AT = "2026-09-09T10:00:10.000Z"

export class EvidenceStore {
  readonly values = new Map<string, Uint8Array>()

  put(uri: string, value: unknown, mediaType = "application/json"): EvidenceReference {
    const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
    this.values.set(uri, bytes)
    return {
      uri,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType,
      observedAtUtc: OBSERVED_AT,
      evidenceClass: "synthetic_fixture",
    }
  }

  readonly resolver: EvidenceResolver = async (reference) => {
    const bytes = this.values.get(reference.uri)
    if (!bytes) throw new Error("missing fixture evidence")
    return bytes
  }
}

export function experimentFixture(): { input: PairedExperimentInput; store: EvidenceStore } {
  const store = new EvidenceStore()
  const task = taskSpec.parse({
    schemaVersion: "knot.task/1",
    taskId: "health-pair-1",
    category: "health",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    target: { borrower: A, comptroller: B, poolFamily: "venus-core" },
    constraints: {
      safetyThresholdRatio: 1.5,
      actionThresholdRatio: 1.4,
      repaymentAsset: C,
      maxRepaymentUnits: "50000000000000000000",
      gasBudgetWei: "0",
      pollIntervalSeconds: 60,
      mode: "notify",
    },
    serviceFeeLimit: { chainId: 97, token: C, units: "100000000000000000", decimals: 18 },
    managedPrincipal: [],
    executionSpendLimits: [],
    deadlineUtc: "2026-09-09T11:00:00.000Z",
    inputHash: ZERO_HASH,
    snapshotId: "snapshot-1",
  })
  const snapshot = {
    schemaVersion: "knot.health.snapshot/1",
    snapshotId: "snapshot-1",
    chainId: 56,
    blockNumber: "65000000",
    blockHash: ONE_HASH,
    blockTimestampUtc: "2026-09-09T10:00:00.000Z",
    capturedAtUtc: "2026-09-09T10:00:00.000Z",
    canonicality: "confirmed",
    sources: [{ uri: "bsc://venus/core", contentHash: ZERO_HASH, method: "eth_call@blockHash" }],
    borrower: A,
    comptroller: B,
    poolFamily: "venus-core",
    debtInventoryComplete: true,
    protocolStatus: "active",
    forcedLiquidation: "enabled",
    actionAvailable: true,
    markets: [
      {
        asset: A,
        symbol: "COL",
        decimals: 18,
        collateralUnits: "100000000000000000000",
        debtUnits: "0",
        oraclePriceUsdE18: "2000000000000000000",
        collateralFactorBps: 7500,
        liquidationThresholdBps: 8000,
        collateralEnabled: true,
        oracleStatus: "current",
        priceObservedAtUtc: "2026-09-09T10:00:00.000Z",
        supported: true,
      },
      {
        asset: C,
        symbol: "DEBT",
        decimals: 18,
        collateralUnits: "0",
        debtUnits: "100000000000000000000",
        oraclePriceUsdE18: "1000000000000000000",
        collateralFactorBps: 0,
        liquidationThresholdBps: 0,
        collateralEnabled: false,
        oracleStatus: "current",
        priceObservedAtUtc: "2026-09-09T10:00:00.000Z",
        supported: true,
      },
    ],
    specialDebts: [{ kind: "VAI", valueUsdE18: "0", supported: true }],
  }
  const request = { schemaVersion: "knot.health.request/1", task, snapshot, maxSnapshotAgeSeconds: 15 }
  const correctArtifact = healthArtifact(task.taskId, snapshot)
  const baselineArtifact = structuredClone(correctArtifact)
  baselineArtifact.metrics.healthRatioE18 = "1500000000000000000"
  const taskReference = store.put("file:task.json", task)
  const inputReference = store.put("file:input.json", request)
  const agentRaw = store.put("file:agent-raw.json", { artifact: correctArtifact })
  const agentArtifact = store.put("file:agent-artifact.json", correctArtifact)
  const baselineRaw = store.put("file:baseline-raw.json", { artifact: baselineArtifact })
  const baselineArtifactReference = store.put("file:baseline-artifact.json", baselineArtifact)
  const implementation = store.put("file:baseline.ts", "export const method = 'reference'", "text/typescript")
  const agentCost = cost(store, "file:agent-cost.json", "service_fee", "100000000000000000", 18, "U", 97, C)
  const baselineCost = cost(store, "file:baseline-cost.json", "compute", "0", 0, "operation", null, null)
  const identity = {
    taskId: task.taskId,
    taskInputHash: task.inputHash,
    snapshotId: task.snapshotId,
    inputSha256: inputReference.sha256,
  }
  return {
    store,
    input: pairedExperimentInput.parse({
      schemaVersion: "knot.advantage.run-input/1",
      experimentId: "synthetic-health-pair-1",
      evidenceClass: "synthetic_fixture",
      task: taskReference,
      input: inputReference,
      agentPath: {
        kind: "agent",
        agent: { chainId: 97, registry: REGISTRY, agentId: "2295" },
        operatorRelationship: "same_operator_reference",
        methodId: "healthguard-agent",
        methodVersion: "1.0.0",
        inputIdentity: identity,
        observation: { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:11.000Z", durationMs: 2000 },
        costs: [agentCost],
        rawOutput: agentRaw,
        artifact: agentArtifact,
      },
      baselinePath: {
        kind: "non_agent_baseline",
        methodId: "health-reference-formula",
        methodVersion: "1.0.0",
        implementation,
        usesSameInput: true,
        usesAgentOutput: false,
        inputIdentity: identity,
        observation: { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:12.000Z", durationMs: 3000 },
        costs: [baselineCost],
        rawOutput: baselineRaw,
        artifact: baselineArtifactReference,
      },
      evaluator: { id: "healthguard-independent", version: "1.0.0" },
    }),
  }
}

function cost(
  store: EvidenceStore,
  uri: string,
  kind: "service_fee" | "network_fee" | "compute" | "data",
  units: string,
  decimals: number,
  symbol: string,
  chainId: 56 | 97 | null,
  token: string | null,
) {
  const payload = {
    schemaVersion: "knot.advantage.cost-evidence/1",
    kind,
    units,
    decimals,
    symbol,
    chainId,
    token,
    observedAtUtc: OBSERVED_AT,
    method: "provider_meter",
    sourceRecordId: `${kind}-fixture`,
  }
  return { kind, amount: { units, decimals, symbol, chainId, token }, provenance: store.put(uri, payload) }
}

function healthArtifact(taskId: string, snapshot: Record<string, unknown>) {
  const markets = snapshot.markets as Array<Record<string, unknown>>
  return {
    schemaVersion: "knot.health.artifact/1",
    category: "health",
    capability: "analysis",
    taskId,
    status: "ASSESSED",
    reasonCode: null,
    assessedAtUtc: OBSERVED_AT,
    snapshot: { snapshotId: snapshot.snapshotId, chainId: 56, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash },
    protocol: { family: "venus-core", comptroller: B, status: "active", forcedLiquidation: "enabled" },
    positions: markets.map((item) => ({
      asset: item.asset,
      symbol: item.symbol,
      collateralUnits: item.collateralUnits,
      debtUnits: item.debtUnits,
      oraclePriceUsdE18: item.oraclePriceUsdE18,
      collateralValueUsdE18: item.symbol === "COL" ? "200000000000000000000" : "0",
      debtValueUsdE18: item.symbol === "DEBT" ? "100000000000000000000" : "0",
      collateralFactorBps: item.collateralFactorBps,
      liquidationThresholdBps: item.liquidationThresholdBps,
      collateralEnabled: item.collateralEnabled,
      priceObservedAtUtc: item.priceObservedAtUtc,
    })),
    metrics: {
      collateralValueUsdE18: "200000000000000000000",
      borrowingPowerCollateralUsdE18: "150000000000000000000",
      liquidationThresholdCollateralUsdE18: "160000000000000000000",
      debtValueUsdE18: "100000000000000000000",
      healthRatioE18: "1600000000000000000",
    },
    missingCoverage: [],
    recommendation: "HOLD",
    minimumEligibleAction: null,
    projectedPostAction: null,
    assumptions: ["prices remain unchanged for projected repayment", "USD values use 18 decimal fixed-point units"],
    limitations: ["analysis only", "does not guarantee liquidation prevention", "does not execute repayment"],
  }
}
