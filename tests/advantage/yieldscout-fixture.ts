import { keccak256, toHex } from "viem"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import { pairedExperimentInput, type PairedExperimentInput } from "../../packages/advantage/src/schemas.ts"
import { yieldScoutEvaluationInput, type YieldScoutEvaluationInput } from "../../packages/advantage/src/yieldscout-schemas.ts"
import { EvidenceStore } from "./fixture.ts"

const ASSET = "0x1111111111111111111111111111111111111111"
const VENUS = "0x2222222222222222222222222222222222222222"
const AAVE = "0x3333333333333333333333333333333333333333"
const RISKY = "0x4444444444444444444444444444444444444444"
const REQUESTER = "0x5555555555555555555555555555555555555555"
const REGISTRY = "0x6666666666666666666666666666666666666666"
const PAYMENT = "0x7777777777777777777777777777777777777777"
const ZERO = `0x${"0".repeat(64)}`
const ONE = `0x${"1".repeat(64)}`
const TWO = `0x${"2".repeat(64)}`
const OBSERVED = "2026-09-09T10:00:10.000Z"

export function yieldExperimentFixture(): { input: PairedExperimentInput; store: EvidenceStore; request: YieldScoutEvaluationInput } {
  const store = new EvidenceStore()
  const request = yieldScoutEvaluationInput.parse({
    schemaVersion: "knot.yield.request/2",
    taskId: "yield-pair-1",
    category: "yield",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    requester: REQUESTER,
    analysisAuthorized: true,
    asset: asset(),
    amountUnits: "1000000000",
    holdingHorizonSeconds: 2592000,
    allowedProtocols: ["venus", "aave-v3"],
    currentMarketId: "venus-usdc",
    withdrawalNeedsUnits: "10000000",
    minimumLiquidityUnits: "100000000",
    concentrationCapBps: 8000,
    gasAllowanceUnits: "1000000",
    minimumImprovementUnits: "1000000",
    noLpExposure: true,
    maxSnapshotAgeSeconds: 300,
    snapshot: {
      schemaVersion: "knot.yield.snapshot/2",
      snapshotId: "yield-snapshot-1",
      chainId: 56,
      blockNumber: "65000000",
      blockHash: ONE,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:01.000Z",
      canonicality: "confirmed",
      sources: [source("bsc://56/yield-snapshot", ZERO)],
      asset: asset(),
      costValuation: { status: "current", asset: asset(), observedAtUtc: "2026-09-09T10:00:01.000Z", source: source("bsc://56/usdc-cost", TWO) },
      markets: [
        market({
          marketId: "venus-usdc",
          integrationId: "venus-core-supply-v1",
          protocol: "venus",
          marketAddress: VENUS,
          periodBasis: { kind: "per_second", periodsPerYear: "31536000", source: source("bsc://56/venus/rate", ZERO) },
          baseRatePerPeriodRay: "1000000000000000000",
          availableLiquidityUnits: "2000000000",
          capacity: { kind: "uncapped", supplyCapUnits: null },
          concentrationBps: 5000,
          entryCostUnits: "0",
          exitCostUnits: "100000",
        }),
        market({
          marketId: "aave-usdc",
          integrationId: "aave-v3-bsc-supply-v1",
          protocol: "aave-v3",
          marketAddress: AAVE,
          periodBasis: { kind: "per_block", periodsPerYear: "10512000", source: source("bsc://56/aave/rate", ONE) },
          baseRatePerPeriodRay: "5000000000000000000",
          incentiveRate: { status: "valued", ratePerPeriodRay: "1000000000000000000", observedAtUtc: "2026-09-09T10:00:01.000Z", valuationSource: source("bsc://56/aave/incentive", TWO) },
          availableLiquidityUnits: "5000000000",
          capacity: { kind: "capped", supplyCapUnits: "200000000000" },
          concentrationBps: 6000,
          entryCostUnits: "100000",
          exitCostUnits: "100000",
        }),
        market({
          marketId: "venus-risky",
          integrationId: "venus-core-supply-v1",
          protocol: "venus",
          marketAddress: RISKY,
          periodBasis: { kind: "per_second", periodsPerYear: "31536000", source: source("bsc://56/venus-risky/rate", TWO) },
          baseRatePerPeriodRay: "9000000000000000000",
          availableLiquidityUnits: "50000000",
          capacity: { kind: "capped", supplyCapUnits: "1500000000" },
          concentrationBps: 9000,
          entryCostUnits: "50000",
          exitCostUnits: "50000",
          riskFlags: ["INCIDENT_ACTIVE"],
        }),
      ],
    },
  })
  const requestBytes = new TextEncoder().encode(JSON.stringify(request))
  const task = taskSpec.parse({
    schemaVersion: "knot.task/1",
    taskId: request.taskId,
    category: "yield",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    target: { asset: ASSET, amountUnits: request.amountUnits },
    constraints: {
      horizonSeconds: request.holdingHorizonSeconds,
      allowedProtocols: request.allowedProtocols,
      allowLpExposure: false,
      minMarketLiquidityUnits: request.minimumLiquidityUnits,
      concentrationCapBps: request.concentrationCapBps,
      gasAllowanceWei: request.gasAllowanceUnits,
      minImprovementBps: 10,
      mode: "analysis",
    },
    serviceFeeLimit: { chainId: 97, token: PAYMENT, units: "100000000000000000", decimals: 18 },
    managedPrincipal: [],
    executionSpendLimits: [],
    deadlineUtc: "2026-09-09T11:00:00.000Z",
    inputHash: keccak256(toHex(requestBytes)),
    snapshotId: request.snapshot.snapshotId,
  })
  const correct = artifact(request)
  const taskReference = store.put("file:yield-task.json", task)
  const inputReference = store.put("file:yield-input.json", request)
  const identity = { taskId: task.taskId, taskInputHash: task.inputHash, snapshotId: task.snapshotId, inputSha256: inputReference.sha256 }
  const agentArtifact = store.put("file:yield-agent-artifact.json", correct)
  const baselineArtifact = store.put("file:yield-baseline-artifact.json", structuredClone(correct))
  return {
    request,
    store,
    input: pairedExperimentInput.parse({
      schemaVersion: "knot.advantage.run-input/1",
      experimentId: "synthetic-yield-pair-1",
      evidenceClass: "synthetic_fixture",
      task: taskReference,
      input: inputReference,
      agentPath: {
        kind: "agent",
        agent: { chainId: 97, registry: REGISTRY, agentId: "2299" },
        operatorRelationship: "same_operator_reference",
        methodId: "yieldscout-agent",
        methodVersion: "1.0.0",
        inputIdentity: identity,
        observation: { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:11.000Z", durationMs: 2000 },
        costs: [cost(store, "file:yield-agent-cost.json", "service_fee", "100000000000000000", 18, "U", 97, PAYMENT)],
        rawOutput: store.put("file:yield-agent-raw.json", { artifact: correct }),
        artifact: agentArtifact,
      },
      baselinePath: {
        kind: "non_agent_baseline",
        methodId: "yield-direct-reference",
        methodVersion: "1.0.0",
        implementation: store.put("file:yield-baseline-method.json", { method: "independent integer rate normalization" }),
        usesSameInput: true,
        usesAgentOutput: false,
        inputIdentity: identity,
        observation: { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:11.000Z", durationMs: 2000 },
        costs: [cost(store, "file:yield-baseline-cost.json", "compute", "1", 0, "ms", null, null)],
        rawOutput: store.put("file:yield-baseline-raw.json", { artifact: correct }),
        artifact: baselineArtifact,
      },
      evaluator: { id: "yieldscout-independent", version: "1.0.0" },
    }),
  }
}

function asset() {
  return { chainId: 56 as const, address: ASSET, symbol: "USDC", decimals: 6, mechanics: "plain_erc20" as const }
}

function source(uri: string, contentHash: string) {
  return { uri, contentHash, method: "eth_call@blockHash" }
}

function market(overrides: Record<string, unknown>) {
  return {
    marketId: "market",
    integrationId: "venus-core-supply-v1",
    protocol: "venus",
    marketAddress: VENUS,
    asset: asset(),
    dataStatus: "current",
    observedAtUtc: "2026-09-09T10:00:01.000Z",
    dataSource: source("bsc://56/market", ZERO),
    periodBasis: { kind: "per_second", periodsPerYear: "31536000", source: source("bsc://56/rate", ZERO) },
    baseRatePerPeriodRay: "0",
    incentiveRate: { status: "none" },
    availableLiquidityUnits: "2000000000",
    capacity: { kind: "uncapped", supplyCapUnits: null },
    totalSuppliedUnits: "1000000000",
    supplyState: "active",
    withdrawalState: "active",
    exposure: "same_asset",
    leverage: false,
    concentrationBps: 5000,
    entryCostUnits: "0",
    exitCostUnits: "0",
    riskFlags: [],
    uncertainty: [],
    ...overrides,
  }
}

function artifact(request: YieldScoutEvaluationInput) {
  return {
    schemaVersion: "knot.yield.artifact/1",
    category: "yield",
    capability: "analysis",
    taskId: request.taskId,
    status: "ASSESSED",
    reasonCode: null,
    assessedAtUtc: OBSERVED,
    evidence: {
      snapshotId: request.snapshot.snapshotId,
      chainId: 56,
      blockNumber: request.snapshot.blockNumber,
      blockHash: request.snapshot.blockHash,
      blockTimestampUtc: request.snapshot.blockTimestampUtc,
      capturedAtUtc: request.snapshot.capturedAtUtc,
      sources: request.snapshot.sources.map((item) => item.uri),
    },
    currentMarketId: "venus-usdc",
    selectedMarketId: "aave-usdc",
    eligibleMarkets: [
      {
        marketId: "venus-usdc",
        protocol: "venus",
        integrationId: "venus-core-supply-v1",
        rateBasis: "per_second",
        baseRateSourceUri: "bsc://56/venus/rate",
        baseAnnualRateRay: "31536000000000000000000000",
        incentiveStatus: "none",
        incentiveValuationSourceUri: null,
        incentiveAnnualRateRay: "0",
        horizonBaseBenefitUnits: "2592000",
        horizonIncentiveBenefitUnits: "0",
        entryCostUnits: "0",
        exitCostUnits: "100000",
        sourceExitCostUnits: "0",
        netBenefitUnits: "2492000",
        improvementVsHoldUnits: "0",
        uncertainty: [],
      },
      {
        marketId: "aave-usdc",
        protocol: "aave-v3",
        integrationId: "aave-v3-bsc-supply-v1",
        rateBasis: "per_block",
        baseRateSourceUri: "bsc://56/aave/rate",
        baseAnnualRateRay: "52560000000000000000000000",
        incentiveStatus: "valued",
        incentiveValuationSourceUri: "bsc://56/aave/incentive",
        incentiveAnnualRateRay: "10512000000000000000000000",
        horizonBaseBenefitUnits: "4320000",
        horizonIncentiveBenefitUnits: "864000",
        entryCostUnits: "100000",
        exitCostUnits: "100000",
        sourceExitCostUnits: "100000",
        netBenefitUnits: "4884000",
        improvementVsHoldUnits: "2392000",
        uncertainty: [],
      },
    ],
    excludedMarkets: [{ marketId: "venus-risky", reasons: ["risk flags are active: INCIDENT_ACTIVE", "available liquidity is below requirement", "remaining supply capacity is insufficient", "concentration exceeds cap"] }],
    recommendation: "MIGRATE",
    recommendationReason: "Independent result",
    assumptions: ["rates remain unchanged over the stated horizon"],
    limitations: ["analysis only"],
  }
}

function cost(store: EvidenceStore, uri: string, kind: "service_fee" | "compute", units: string, decimals: number, symbol: string, chainId: 97 | null, token: string | null) {
  return {
    kind,
    amount: { units, decimals, symbol, chainId, token },
    provenance: store.put(uri, { schemaVersion: "knot.advantage.cost-evidence/1", kind, units, decimals, symbol, chainId, token, observedAtUtc: OBSERVED, method: "provider_meter", sourceRecordId: `${kind}-fixture` }),
  }
}
