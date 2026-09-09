import { keccak256, toHex } from "viem"
import { gridQuantEvaluationInput, type GridQuantEvaluationInput } from "../../packages/advantage/src/gridquant-schemas.ts"
import { pairedExperimentInput, type PairedExperimentInput } from "../../packages/advantage/src/schemas.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import { EvidenceStore } from "./fixture.ts"

const REQUESTER = "0x1111111111111111111111111111111111111111"
const BASE = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
const QUOTE = "0x55d398326f99059ff775485246999027b3197955"
const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849"
const REGISTRY = "0x2222222222222222222222222222222222222222"
const PAYMENT = "0x3333333333333333333333333333333333333333"
const COMMERCE = "0x4444444444444444444444444444444444444444"
const POLICY = "0x5555555555555555555555555555555555555555"
const ROUTER = "0x6666666666666666666666666666666666666666"
const HASH = `0x${"a".repeat(64)}`
const ASSESSED_AT = "2026-09-09T10:00:10.000Z"

export function gridExperimentFixture(): { input: PairedExperimentInput; store: EvidenceStore; request: GridQuantEvaluationInput } {
  const store = new EvidenceStore()
  const request = gridQuantEvaluationInput.parse({
    schemaVersion: "knot.gridquant.request/2",
    task: {
      schemaVersion: "knot.gridquant.task/1",
      taskId: "grid-pair-1",
      category: "grid",
      capability: "analysis",
      identityChainId: 97,
      dataChainId: 56,
      paymentChainId: 97,
      executionChainId: null,
      requester: REQUESTER,
      pair: pair(),
      parameters: {
        lowerPriceUnits: "50000",
        upperPriceUnits: "80000",
        priceDecimals: 2,
        gridCount: 4,
        spacing: "arithmetic",
        principalQuoteUnits: "1000000000000000000000",
        orderSizeFloorQuoteUnits: "100000000000000000000",
        maxBaseInventoryUnits: "3000000000000000000",
        feeAssumptions: { buyFeeBps: 25, sellFeeBps: 25 },
        slippageBps: 10,
        cooldownSeconds: 300,
        expiryUtc: "2026-09-10T00:00:00.000Z",
        executionMode: "analysis",
      },
      snapshotId: "grid-snapshot-1",
    },
    snapshot: {
      schemaVersion: "knot.gridquant.snapshot/1",
      snapshotId: "grid-snapshot-1",
      chainId: 56,
      blockNumber: "120852687",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:05.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://56/pancakeswap-v3/wbnb-usdt", contentHash: HASH, method: "eth_call@blockHash" }],
      requester: REQUESTER,
      analysisAuthorized: true,
      pair: pair(),
      lastActionUtc: null,
      gasEstimate: {
        gasUnits: "300000",
        gasPriceWei: "1000000000",
        nativeTokenPriceQuoteUnits: "600000000000000000000",
        estimatedNetworkFeeQuoteUnitsPerSwap: "180000000000000000",
        estimatedAtUtc: "2026-09-09T10:00:06.000Z",
        method: "eth_estimateGas and pinned quote conversion",
      },
    },
    maxSnapshotAgeSeconds: 15,
  })
  const requestBytes = new TextEncoder().encode(JSON.stringify(request))
  const parameters = request.task.parameters
  const task = taskSpec.parse({
    schemaVersion: "knot.task/1",
    taskId: request.task.taskId,
    category: "grid",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    target: { baseToken: BASE, quoteToken: QUOTE, pool: POOL },
    constraints: {
      lowerPriceUnits: parameters.lowerPriceUnits,
      upperPriceUnits: parameters.upperPriceUnits,
      gridCount: parameters.gridCount,
      spacing: parameters.spacing,
      principalUnits: parameters.principalQuoteUnits,
      orderSizeFloorUnits: parameters.orderSizeFloorQuoteUnits,
      maxInventoryExposureUnits: parameters.maxBaseInventoryUnits,
      slippageBps: parameters.slippageBps,
      cooldownSeconds: parameters.cooldownSeconds,
      expiryUtc: parameters.expiryUtc,
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
  const taskReference = store.put("file:grid-task.json", task)
  const inputReference = store.put("file:grid-input.json", request)
  const identity = { taskId: task.taskId, taskInputHash: task.inputHash, snapshotId: task.snapshotId, inputSha256: inputReference.sha256 }
  return {
    request,
    store,
    input: pairedExperimentInput.parse({
      schemaVersion: "knot.advantage.run-input/1",
      experimentId: "synthetic-grid-pair-1",
      evidenceClass: "synthetic_fixture",
      task: taskReference,
      input: inputReference,
      agentPath: {
        kind: "agent",
        agent: { chainId: 97, registry: REGISTRY, agentId: "2298" },
        operatorRelationship: "same_operator_reference",
        methodId: "gridquant-agent",
        methodVersion: "1.0.0",
        inputIdentity: identity,
        observation: observation(),
        costs: [cost(store, "file:grid-agent-cost.json", "service_fee", "100000000000000000", 18, "U", 97, PAYMENT)],
        rawOutput: store.put("file:grid-agent-manifest.json", manifest(correct)),
        artifact: store.put("file:grid-agent-artifact.json", correct),
      },
      baselinePath: {
        kind: "non_agent_baseline",
        methodId: "grid-direct-reference",
        methodVersion: "1.0.0",
        implementation: store.put("file:grid-baseline-method.json", { method: "independent integer grid construction" }),
        usesSameInput: true,
        usesAgentOutput: false,
        inputIdentity: identity,
        observation: observation(),
        costs: [cost(store, "file:grid-baseline-cost.json", "compute", "1", 0, "ms", null, null)],
        rawOutput: store.put("file:grid-baseline-raw.json", { artifact: correct }),
        artifact: store.put("file:grid-baseline-artifact.json", structuredClone(correct)),
      },
      evaluator: { id: "gridquant-independent", version: "1.0.0" },
    }),
  }
}

function artifact(request: GridQuantEvaluationInput) {
  return {
    schemaVersion: "knot.gridquant.artifact/1",
    category: "grid",
    capability: "analysis",
    taskId: request.task.taskId,
    status: "ANALYZED",
    reasonCode: "PLAN",
    assessedAtUtc: ASSESSED_AT,
    evidence: { snapshotId: request.snapshot.snapshotId, chainId: 56, blockNumber: request.snapshot.blockNumber, blockHash: request.snapshot.blockHash, blockTimestampUtc: request.snapshot.blockTimestampUtc, capturedAtUtc: request.snapshot.capturedAtUtc, gasEstimatedAtUtc: request.snapshot.gasEstimate?.estimatedAtUtc ?? null, sources: request.snapshot.sources.map((source) => source.uri) },
    timing: { evaluatedAtUtc: ASSESSED_AT, expiryUtc: request.task.parameters.expiryUtc, cooldownSeconds: 300, lastActionUtc: null },
    result: {
      outcome: "PLAN",
      pairId: "bsc:WBNB/USDT:pancakeswap-v3",
      spacing: "arithmetic",
      levels: [
        level(0, "50000", "250000000000000000000", "500000000000000000"),
        level(1, "60000", "250000000000000000000", "416666666666666666"),
        level(2, "70000", "250000000000000000000", "357142857142857142"),
        level(3, "80000", "250000000000000000000", "312500000000000000"),
      ],
      capital: { principalQuoteUnits: "1000000000000000000000", maximumCommittedQuoteUnits: "1000000000000000000000", maximumBaseInventoryUnits: "1586309523809523808", baseInventoryLimitUnits: "3000000000000000000" },
      fees: { buyFeeBps: 25, sellFeeBps: 25, slippageBpsPerSwap: 10, estimatedRoundTripNetworkFeeQuoteUnits: "360000000000000000", minimumGrossAdjacentSpreadBpsFloor: "1428", conservativeBreakEvenBps: "85" },
      parameterChecks: ["SUPPORTED_PAIR", "SUPPORTED_DECIMALS", "ANALYSIS_ONLY", "PINNED_SNAPSHOT", "AUTHORIZED_ANALYSIS", "ORDERED_BOUNDS", "GRID_COUNT", "UNIQUE_LEVELS", "CAPITAL_CONSERVED", "INVENTORY_EXPOSURE", "FEES_BELOW_SPREAD", "COOLDOWN_ELAPSED"],
    },
    fillPolicy: { executionModel: "OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS", ambiguousFill: "NO_FILL", sameSideRetrigger: "REFUSED", requiresObservedReceiptForFill: true },
    historicalEvaluation: null,
    performance: { realizedPnlQuoteUnits: null, openInventoryMarkToMarketQuoteUnits: null, completedTradeCount: 0, basis: "NO_OBSERVED_FILLS" },
    limitations: ["analysis only; no order, swap, or liquidity transaction is signed", "historical performance and future return are unavailable", "a grid level is not a fill without an observed transaction receipt"],
  }
}

function pair() {
  return {
    chainId: 56 as const,
    baseToken: { address: BASE, symbol: "WBNB", decimals: 18, mechanics: "plain_erc20" as const },
    quoteToken: { address: QUOTE, symbol: "USDT", decimals: 18, mechanics: "plain_erc20" as const },
    pool: POOL,
  }
}

function level(index: number, priceUnits: string, allocatedQuoteUnits: string, estimatedBaseUnits: string) {
  return { index, priceUnits, priceDecimals: 2, allocatedQuoteUnits, estimatedBaseUnits, amountRounding: "DOWN" }
}

function manifest(value: unknown) {
  return { version: 1, chain_id: 97, job_id: 1201, contracts: { commerce: COMMERCE, policy: POLICY, router: ROUTER }, metadata: { built_with: "https://github.com/bnb-chain/bnbagent-studio", generator: "KNOT GridQuant", job_id: 1201 }, response: { content: JSON.stringify(value), content_type: "text/plain" } }
}

function observation() {
  return { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:11.000Z", durationMs: 2000 }
}

function cost(store: EvidenceStore, uri: string, kind: "service_fee" | "compute", units: string, decimals: number, symbol: string, chainId: 97 | null, token: string | null) {
  return { kind, amount: { units, decimals, symbol, chainId, token }, provenance: store.put(uri, { schemaVersion: "knot.advantage.cost-evidence/1", kind, units, decimals, symbol, chainId, token, observedAtUtc: ASSESSED_AT, method: "provider_meter", sourceRecordId: `${kind}-fixture` }) }
}
