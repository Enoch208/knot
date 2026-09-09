import { keccak256, toHex } from "viem"
import { pairedExperimentInput, type PairedExperimentInput } from "../../packages/advantage/src/schemas.ts"
import { rangePilotEvaluationInput, type RangePilotEvaluationInput } from "../../packages/advantage/src/rangepilot-schemas.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import { EvidenceStore } from "./fixture.ts"

const MANAGER = "0x1111111111111111111111111111111111111111"
const OWNER = "0x2222222222222222222222222222222222222222"
const POOL = "0x3333333333333333333333333333333333333333"
const FACTORY = "0x4444444444444444444444444444444444444444"
const TOKEN0 = "0x5555555555555555555555555555555555555555"
const TOKEN1 = "0x6666666666666666666666666666666666666666"
const REGISTRY = "0x7777777777777777777777777777777777777777"
const PAYMENT = "0x8888888888888888888888888888888888888888"
const HASH = `0x${"a".repeat(64)}`
const LARGE = "1000000000000000000000000000000000000"
const ASSESSED_AT = "2026-09-09T10:00:10.000Z"

export function rangeExperimentFixture(): { input: PairedExperimentInput; store: EvidenceStore; request: RangePilotEvaluationInput } {
  const store = new EvidenceStore()
  const request = rangePilotEvaluationInput.parse({
    schemaVersion: "knot.rangepilot.request/1",
    task: {
      schemaVersion: "knot.rangepilot.task/1",
      taskId: "range-pair-1",
      category: "rebalancing",
      capability: "analysis",
      chainId: 56,
      positionManager: MANAGER,
      positionTokenId: "42",
      controllingAccount: OWNER,
      allowedPool: {
        address: POOL,
        factory: FACTORY,
        token0: token(TOKEN0, "USDC", 6),
        token1: token(TOKEN1, "WBNB", 18),
        feeTier: 2500,
        tickSpacing: 50,
        minimumTick: -887250,
        maximumTick: 887250,
        maximumSlippageBps: 100,
      },
      constraints: {
        token0BudgetUnits: LARGE,
        token1BudgetUnits: LARGE,
        minimumRangeWidthTicks: 100,
        targetRangeWidthTicks: 200,
        maximumRangeWidthTicks: 300,
        maximumSlippageBps: 50,
        gasBudgetWei: "500000000000000",
        cooldownSeconds: 300,
        executionMode: "analysis",
      },
      snapshotId: "range-snapshot-1",
    },
    snapshot: {
      schemaVersion: "knot.rangepilot.snapshot/1",
      snapshotId: "range-snapshot-1",
      chainId: 56,
      blockNumber: "65000000",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:05.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://56/pancakeswap-v3/position/42", contentHash: HASH, method: "eth_call@blockHash" }],
      positionManager: MANAGER,
      positionTokenId: "42",
      position: {
        owner: OWNER,
        pool: POOL,
        token0: TOKEN0,
        token1: TOKEN1,
        feeTier: 2500,
        tickLower: -100,
        tickUpper: 100,
        liquidity: "1000000000000000000",
        feeGrowthInside0LastX128: "12",
        feeGrowthInside1LastX128: "15",
        tokensOwed0: "1000000",
        tokensOwed1: "2000000000000000",
        farmed: false,
      },
      pool: {
        protocol: "pancakeswap-v3",
        address: POOL,
        factory: FACTORY,
        token0: { ...token(TOKEN0, "USDC", 6), balanceUnits: LARGE },
        token1: { ...token(TOKEN1, "WBNB", 18), balanceUnits: LARGE },
        feeTier: 2500,
        tickSpacing: 50,
        currentTick: 150,
        sqrtPriceX96: "79824577674156242016003546387",
        activeLiquidity: "5000000000000000000",
        initialized: true,
        hasHooks: false,
      },
      account: { address: OWNER, canManagePosition: true },
      lastCompletedActionAtUtc: null,
      gasEstimate: { gasUnits: "300000", gasPriceWei: "1000000000", estimatedAtUtc: "2026-09-09T10:00:06.000Z", method: "eth_estimateGas@blockHash" },
    },
    maxSnapshotAgeSeconds: 15,
  })
  const requestBytes = new TextEncoder().encode(JSON.stringify(request))
  const task = taskSpec.parse({
    schemaVersion: "knot.task/1",
    taskId: request.task.taskId,
    category: "rebalancing",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    target: { positionManager: MANAGER, positionTokenId: "42", controllingAccount: OWNER, pool: POOL },
    constraints: {
      token0BudgetUnits: LARGE,
      token1BudgetUnits: LARGE,
      minimumRangeWidthTicks: 100,
      targetRangeWidthTicks: 200,
      maximumRangeWidthTicks: 300,
      maximumSlippageBps: 50,
      gasBudgetWei: "500000000000000",
      cooldownSeconds: 300,
      executionMode: "analysis",
    },
    serviceFeeLimit: { chainId: 97, token: PAYMENT, units: "100000000000000000", decimals: 18 },
    managedPrincipal: [],
    executionSpendLimits: [],
    deadlineUtc: "2026-09-09T11:00:00.000Z",
    inputHash: keccak256(toHex(requestBytes)),
    snapshotId: request.snapshot.snapshotId,
  })
  const correct = artifact(request)
  const taskReference = store.put("file:range-task.json", task)
  const inputReference = store.put("file:range-input.json", request)
  const identity = { taskId: task.taskId, taskInputHash: task.inputHash, snapshotId: task.snapshotId, inputSha256: inputReference.sha256 }
  return {
    request,
    store,
    input: pairedExperimentInput.parse({
      schemaVersion: "knot.advantage.run-input/1",
      experimentId: "synthetic-range-pair-1",
      evidenceClass: "synthetic_fixture",
      task: taskReference,
      input: inputReference,
      agentPath: {
        kind: "agent",
        agent: { chainId: 97, registry: REGISTRY, agentId: "2297" },
        operatorRelationship: "same_operator_reference",
        methodId: "rangepilot-agent",
        methodVersion: "1.0.0",
        inputIdentity: identity,
        observation: observation(),
        costs: [cost(store, "file:range-agent-cost.json", "service_fee", "100000000000000000", 18, "U", 97, PAYMENT)],
        rawOutput: store.put("file:range-agent-raw.json", { artifact: correct }),
        artifact: store.put("file:range-agent-artifact.json", correct),
      },
      baselinePath: {
        kind: "non_agent_baseline",
        methodId: "range-direct-reference",
        methodVersion: "1.0.0",
        implementation: store.put("file:range-baseline-method.json", { method: "independent V3 integer range calculation" }),
        usesSameInput: true,
        usesAgentOutput: false,
        inputIdentity: identity,
        observation: observation(),
        costs: [cost(store, "file:range-baseline-cost.json", "compute", "1", 0, "ms", null, null)],
        rawOutput: store.put("file:range-baseline-raw.json", { artifact: correct }),
        artifact: store.put("file:range-baseline-artifact.json", structuredClone(correct)),
      },
      evaluator: { id: "rangepilot-independent", version: "1.0.0" },
    }),
  }
}

function artifact(request: RangePilotEvaluationInput) {
  return {
    schemaVersion: "knot.rangepilot.artifact/1",
    category: "rebalancing",
    capability: "analysis",
    taskId: request.task.taskId,
    status: "ANALYZED",
    reasonCode: "OUT_OF_RANGE",
    assessedAtUtc: ASSESSED_AT,
    evidence: { snapshotId: request.snapshot.snapshotId, chainId: 56, blockNumber: request.snapshot.blockNumber, blockHash: request.snapshot.blockHash, blockTimestampUtc: request.snapshot.blockTimestampUtc, capturedAtUtc: request.snapshot.capturedAtUtc, gasEstimatedAtUtc: request.snapshot.gasEstimate?.estimatedAtUtc ?? null },
    currentState: {
      owner: OWNER,
      pool: POOL,
      token0: token(TOKEN0, "USDC", 6),
      token1: token(TOKEN1, "WBNB", 18),
      currentTick: 150,
      tickLower: -100,
      tickUpper: 100,
      tickSpacing: 50,
      liquidity: "1000000000000000000",
      activeLiquidity: "5000000000000000000",
      amount0Units: "0",
      amount1Units: "9999541693800299",
      tokensOwed0: "1000000",
      tokensOwed1: "2000000000000000",
      condition: "OUT_OF_RANGE",
    },
    decision: "PROPOSE_RANGE",
    proposal: {
      tickLower: 50,
      tickUpper: 250,
      widthTicks: 200,
      liquidity: "1000000000000000000",
      amount0Units: "4950009303363817",
      amount1Units: "5024815345452263",
      maximumSlippageBps: 50,
      gasEstimateWei: "300000000000000",
      eligible: true,
      checks: [
        check("TICK_BOUNDS", true, "50:250:200", "-887250:887250:100:300"),
        check("TOKEN0_BUDGET", true, "4950009303363817", LARGE),
        check("TOKEN1_BUDGET", true, "5024815345452263", LARGE),
        check("TOKEN0_AVAILABLE", true, "4950009303363817", "1000000000000000000000000000001000000"),
        check("TOKEN1_AVAILABLE", true, "5024815345452263", "1000000000000000000011999541693800299"),
        check("SLIPPAGE_BOUND", true, "50", "100"),
        check("GAS_BUDGET", true, "300000000000000", "500000000000000"),
        check("COOLDOWN", true, "no prior action", ASSESSED_AT),
      ],
    },
    assumptions: [
      "all position, pool, price, liquidity, ownership, and balance fields share the identified block",
      "proposal amounts preserve current position liquidity and use conservative token0 rounding",
      "no future return or narrower-range yield advantage is inferred",
    ],
    unavailableMetrics: ["realized fees", "historical time in range", "future yield", "swap price impact"],
  }
}

function token(address: string, symbol: string, decimals: number) {
  return { address, symbol, decimals, mechanics: "plain_erc20" as const }
}

function check(code: string, passed: boolean, observed: string, limit: string) {
  return { code, passed, observed, limit }
}

function observation() {
  return { startedAtUtc: "2026-09-09T10:00:09.000Z", endedAtUtc: "2026-09-09T10:00:11.000Z", durationMs: 2000 }
}

function cost(store: EvidenceStore, uri: string, kind: "service_fee" | "compute", units: string, decimals: number, symbol: string, chainId: 97 | null, tokenAddress: string | null) {
  return {
    kind,
    amount: { units, decimals, symbol, chainId, token: tokenAddress },
    provenance: store.put(uri, { schemaVersion: "knot.advantage.cost-evidence/1", kind, units, decimals, symbol, chainId, token: tokenAddress, observedAtUtc: ASSESSED_AT, method: "provider_meter", sourceRecordId: `${kind}-fixture` }),
  }
}
