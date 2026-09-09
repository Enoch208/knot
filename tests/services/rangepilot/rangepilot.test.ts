import assert from "node:assert/strict"
import test from "node:test"
import {
  analyzeRangePilot,
  analyzeRangePilotText,
  rangePilotArtifact,
  rangePilotRequest,
  sqrtRatioAtTick,
  type RangePilotRequest,
} from "../../../packages/services/rangepilot/src/index.ts"

const NOW = new Date("2026-09-09T10:00:10.000Z")
const MANAGER = "0x1111111111111111111111111111111111111111"
const OWNER = "0x2222222222222222222222222222222222222222"
const POOL = "0x3333333333333333333333333333333333333333"
const FACTORY = "0x4444444444444444444444444444444444444444"
const TOKEN0 = "0x5555555555555555555555555555555555555555"
const TOKEN1 = "0x6666666666666666666666666666666666666666"
const HASH = `0x${"a".repeat(64)}`
const LARGE = "1000000000000000000000000000000000000"

function fixture(): RangePilotRequest {
  return rangePilotRequest.parse({
    schemaVersion: "knot.rangepilot.request/1",
    task: {
      schemaVersion: "knot.rangepilot.task/1",
      taskId: "range-1",
      category: "rebalancing",
      capability: "analysis",
      chainId: 56,
      positionManager: MANAGER,
      positionTokenId: "42",
      controllingAccount: OWNER,
      allowedPool: {
        address: POOL,
        factory: FACTORY,
        token0: { address: TOKEN0, symbol: "USDC", decimals: 6, mechanics: "plain_erc20" },
        token1: { address: TOKEN1, symbol: "WBNB", decimals: 18, mechanics: "plain_erc20" },
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
      blockNumber: "12345678",
      blockHash: HASH,
      blockTimestampUtc: "2026-09-09T10:00:00.000Z",
      capturedAtUtc: "2026-09-09T10:00:05.000Z",
      canonicality: "confirmed",
      sources: [{ uri: "bsc://block/12345678", contentHash: HASH, method: "eth_call at block hash" }],
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
        token0: { address: TOKEN0, symbol: "USDC", decimals: 6, mechanics: "plain_erc20", balanceUnits: LARGE },
        token1: { address: TOKEN1, symbol: "WBNB", decimals: 18, mechanics: "plain_erc20", balanceUnits: LARGE },
        feeTier: 2500,
        tickSpacing: 50,
        currentTick: 0,
        sqrtPriceX96: sqrtRatioAtTick(0).toString(),
        activeLiquidity: "5000000000000000000",
        initialized: true,
        hasHooks: false,
      },
      account: { address: OWNER, canManagePosition: true },
      lastCompletedActionAtUtc: null,
      gasEstimate: {
        gasUnits: "300000",
        gasPriceWei: "1000000000",
        estimatedAtUtc: "2026-09-09T10:00:06.000Z",
        method: "eth_estimateGas against pinned state",
      },
    },
    maxSnapshotAgeSeconds: 15,
  })
}

test("returns a schema-valid hold for an in-range position without inventing history", () => {
  const artifact = analyzeRangePilot(fixture(), NOW)
  assert.equal(artifact.status, "ANALYZED")
  assert.equal(artifact.reasonCode, "IN_RANGE_HOLD")
  assert.equal(artifact.currentState?.condition, "IN_RANGE")
  assert.equal(artifact.decision, "HOLD")
  assert.equal(artifact.proposal, null)
  assert.ok(artifact.unavailableMetrics.includes("realized fees"))
  assert.equal(rangePilotArtifact.safeParse(artifact).success, true)
})

test("proposes tick-aligned bounded amounts for an out-of-range position", () => {
  const input = fixture()
  input.snapshot.pool.currentTick = 150
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString()
  const artifact = analyzeRangePilot(input, NOW)
  assert.equal(artifact.status, "ANALYZED")
  assert.equal(artifact.currentState?.condition, "OUT_OF_RANGE")
  assert.equal(artifact.decision, "PROPOSE_RANGE")
  assert.equal(artifact.proposal?.tickLower, 50)
  assert.equal(artifact.proposal?.tickUpper, 250)
  assert.equal(artifact.proposal?.widthTicks, 200)
  assert.equal(artifact.proposal?.amount0Units, "4950009303363817")
  assert.equal(artifact.proposal?.amount1Units, "5024815345452263")
  assert.equal(artifact.proposal?.gasEstimateWei, "300000000000000")
  assert.ok(artifact.proposal?.checks.every((check) => check.passed))
})

test("uses actual token order and decimals rather than accepting task identity drift", () => {
  const reversed = fixture()
  reversed.snapshot.position.token0 = TOKEN1
  assert.equal(analyzeRangePilot(reversed, NOW).reasonCode, "TOKEN0_IDENTITY_MISMATCH")

  const decimals = fixture()
  decimals.snapshot.pool.token1.decimals = 8
  assert.equal(analyzeRangePilot(decimals, NOW).reasonCode, "TOKEN_DECIMALS_MISMATCH")
})

test("refuses ownership, pool, and permission mismatches", () => {
  const owner = fixture()
  owner.snapshot.position.owner = "0x7777777777777777777777777777777777777777"
  assert.equal(analyzeRangePilot(owner, NOW).reasonCode, "OWNER_MISMATCH")

  const pool = fixture()
  pool.snapshot.pool.address = "0x8888888888888888888888888888888888888888"
  assert.equal(analyzeRangePilot(pool, NOW).reasonCode, "POOL_IDENTITY_MISMATCH")

  const permission = fixture()
  permission.snapshot.account.canManagePosition = false
  assert.equal(analyzeRangePilot(permission, NOW).reasonCode, "AUTHORITY_MISMATCH")
})

test("refuses farmed positions, hooks, and exotic token mechanics", () => {
  const farmed = fixture()
  farmed.snapshot.position.farmed = true
  assert.equal(analyzeRangePilot(farmed, NOW).reasonCode, "FARMED_POSITION_UNSUPPORTED")

  const hooked = fixture()
  hooked.snapshot.pool.hasHooks = true
  assert.equal(analyzeRangePilot(hooked, NOW).reasonCode, "HOOKS_UNSUPPORTED")

  const exotic = fixture()
  exotic.task.allowedPool.token0.mechanics = "fee_on_transfer"
  exotic.snapshot.pool.token0.mechanics = "fee_on_transfer"
  assert.equal(analyzeRangePilot(exotic, NOW).reasonCode, "TOKEN_MECHANICS_UNSUPPORTED")
})

test("refuses unaligned ranges and inconsistent pool price ticks", () => {
  const ticks = fixture()
  ticks.snapshot.position.tickLower = -99
  assert.equal(analyzeRangePilot(ticks, NOW).reasonCode, "POSITION_TICKS_UNALIGNED")

  const price = fixture()
  price.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(1).toString()
  assert.equal(analyzeRangePilot(price, NOW).reasonCode, "POOL_PRICE_TICK_MISMATCH")
})

test("fails stale, orphaned, and analysis-incompatible requests closed", () => {
  const stale = fixture()
  stale.snapshot.capturedAtUtc = "2026-09-09T09:59:00.000Z"
  assert.equal(analyzeRangePilot(stale, NOW).status, "STALE_SNAPSHOT")

  const orphaned = fixture()
  orphaned.snapshot.canonicality = "orphaned"
  assert.equal(analyzeRangePilot(orphaned, NOW).status, "STALE_SNAPSHOT")

  const execution = fixture()
  execution.task.capability = "execution"
  execution.task.constraints.executionMode = "unattended"
  assert.equal(analyzeRangePilot(execution, NOW).reasonCode, "ANALYSIS_ONLY")
})

test("rejects an out-of-range proposal that exceeds a raw-unit token budget", () => {
  const input = fixture()
  input.snapshot.pool.currentTick = 150
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString()
  input.task.constraints.token0BudgetUnits = "1"
  const artifact = analyzeRangePilot(input, NOW)
  assert.equal(artifact.status, "PLAN_REJECTED")
  assert.equal(artifact.decision, "REFUSED")
  assert.equal(artifact.proposal?.eligible, false)
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "TOKEN0_BUDGET")?.passed, false)
})

test("rejects unavailable assets, excessive slippage, and missing gas evidence", () => {
  const input = fixture()
  input.snapshot.pool.currentTick = 150
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString()
  input.snapshot.pool.token0.balanceUnits = "0"
  input.snapshot.position.tokensOwed0 = "0"
  input.task.constraints.maximumSlippageBps = 101
  input.snapshot.gasEstimate = null
  const artifact = analyzeRangePilot(input, NOW)
  assert.equal(artifact.status, "PLAN_REJECTED")
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "TOKEN0_AVAILABLE")?.passed, false)
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "SLIPPAGE_BOUND")?.passed, false)
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "GAS_BUDGET")?.passed, false)
})

test("holds during cooldown while retaining a transparent ineligible proposal", () => {
  const input = fixture()
  input.snapshot.pool.currentTick = 150
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(150).toString()
  input.snapshot.lastCompletedActionAtUtc = "2026-09-09T09:58:00.000Z"
  const artifact = analyzeRangePilot(input, NOW)
  assert.equal(artifact.status, "ANALYZED")
  assert.equal(artifact.reasonCode, "COOLDOWN_ACTIVE")
  assert.equal(artifact.decision, "HOLD")
  assert.equal(artifact.proposal?.checks.filter((check) => !check.passed).map((check) => check.code).join(), "COOLDOWN")
})

test("shifts a proposal at the legal tick edge without leaving the allowlist", () => {
  const input = fixture()
  input.task.allowedPool.minimumTick = -200
  input.task.allowedPool.maximumTick = 200
  input.snapshot.position.tickLower = -200
  input.snapshot.position.tickUpper = -100
  input.snapshot.pool.currentTick = 199
  input.snapshot.pool.sqrtPriceX96 = sqrtRatioAtTick(199).toString()
  const artifact = analyzeRangePilot(input, NOW)
  assert.equal(artifact.proposal?.tickLower, 0)
  assert.equal(artifact.proposal?.tickUpper, 200)
  assert.equal(artifact.proposal?.checks.find((check) => check.code === "TICK_BOUNDS")?.passed, true)
})

test("rejects unknown fields and malformed JSON through the closed text boundary", () => {
  const unknown = { ...fixture(), trustedByBrowser: true }
  const artifact = JSON.parse(analyzeRangePilotText(JSON.stringify(unknown), NOW)) as { status: string; reasonCode: string }
  assert.equal(artifact.status, "INVALID_REQUEST")
  assert.equal(artifact.reasonCode, "SCHEMA_VALIDATION_FAILED")
  assert.equal(JSON.parse(analyzeRangePilotText("not-json", NOW)).reasonCode, "INVALID_JSON")
})
