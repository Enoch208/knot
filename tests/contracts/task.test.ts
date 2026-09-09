import { test } from "node:test"
import assert from "node:assert/strict"
import { CROSS_NETWORK_EXECUTION_REFUSED, taskSpec } from "../../packages/contracts/src/task.ts"

const U_TESTNET = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384"
const BORROWER = "0x1111111111111111111111111111111111111111"
const RANGE_MANAGER = "0x2222222222222222222222222222222222222222"
const RANGE_OWNER = "0x3333333333333333333333333333333333333333"
const RANGE_POOL = "0x4444444444444444444444444444444444444444"

const healthTask = (over: Record<string, unknown> = {}) => ({
  schemaVersion: "knot.task/1",
  taskId: "task_health_1",
  category: "health",
  capability: "analysis",
  identityChainId: 97,
  dataChainId: 56,
  paymentChainId: 97,
  executionChainId: null,
  target: { borrower: BORROWER, comptroller: VENUS_COMPTROLLER, poolFamily: "venus-core" },
  constraints: {
    safetyThresholdRatio: 1.5,
    actionThresholdRatio: 1.2,
    repaymentAsset: U_TESTNET,
    maxRepaymentUnits: "1000000000000000000",
    gasBudgetWei: "5000000000000000",
    pollIntervalSeconds: 300,
    mode: "notify",
  },
  serviceFeeLimit: { chainId: 97, token: U_TESTNET, units: "100000000000000000", decimals: 18 },
  managedPrincipal: [],
  executionSpendLimits: [],
  deadlineUtc: "2026-09-09T00:00:00.000Z",
  inputHash: `0x${"a".repeat(64)}`,
  snapshotId: null,
  ...over,
})

const rebalancingTask = (constraints: Record<string, unknown> = {}) => ({
  schemaVersion: "knot.task/1",
  taskId: "task_range_1",
  category: "rebalancing",
  capability: "analysis",
  identityChainId: 97,
  dataChainId: 56,
  paymentChainId: 97,
  executionChainId: null,
  target: { positionManager: RANGE_MANAGER, positionTokenId: "42", controllingAccount: RANGE_OWNER, pool: RANGE_POOL },
  constraints: {
    token0BudgetUnits: "1000000",
    token1BudgetUnits: "2000000000000000",
    minimumRangeWidthTicks: 100,
    targetRangeWidthTicks: 200,
    maximumRangeWidthTicks: 300,
    maximumSlippageBps: 50,
    gasBudgetWei: "500000000000000",
    cooldownSeconds: 300,
    executionMode: "analysis",
    ...constraints,
  },
  serviceFeeLimit: { chainId: 97, token: U_TESTNET, units: "100000000000000000", decimals: 18 },
  managedPrincipal: [],
  executionSpendLimits: [],
  deadlineUtc: "2026-09-09T00:00:00.000Z",
  inputHash: `0x${"b".repeat(64)}`,
  snapshotId: "range-snapshot-1",
})

test("a paid testnet service may analyze a mainnet snapshot", () => {
  const parsed = taskSpec.parse(healthTask())
  assert.equal(parsed.dataChainId, 56)
  assert.equal(parsed.paymentChainId, 97)
})

test("mainnet analysis never authorizes testnet execution", () => {
  const result = taskSpec.safeParse(
    healthTask({ capability: "execution", executionChainId: 97, dataChainId: 56 }),
  )
  assert.equal(result.success, false)
  assert.ok(
    result.error?.issues.some((issue) => issue.message === CROSS_NETWORK_EXECUTION_REFUSED),
    "expected the cross-network refusal",
  )
})

test("an execution task must name its execution network", () => {
  const result = taskSpec.safeParse(healthTask({ capability: "execution", executionChainId: null }))
  assert.equal(result.success, false)
})

test("an analysis task may not carry spend limits", () => {
  const result = taskSpec.safeParse(
    healthTask({
      executionSpendLimits: [
        { chainId: 97, token: U_TESTNET, units: "1", decimals: 18 },
      ],
    }),
  )
  assert.equal(result.success, false)
})

test("an unknown constraint field is rejected rather than ignored", () => {
  const base = healthTask()
  const result = taskSpec.safeParse({
    ...base,
    constraints: { ...base.constraints, maxRepaymentUnitsOverride: "999999999999999999999" },
  })
  assert.equal(result.success, false)
})

test("an action threshold above the safety threshold is rejected", () => {
  const base = healthTask()
  const result = taskSpec.safeParse({
    ...base,
    constraints: { ...base.constraints, actionThresholdRatio: 2.0, safetyThresholdRatio: 1.5 },
  })
  assert.equal(result.success, false)
})

test("amounts are integer base-unit strings, never floats or negatives", () => {
  const base = healthTask()
  for (const units of ["1.5", "-1", "1e18", "", "0x10"]) {
    const result = taskSpec.safeParse({
      ...base,
      constraints: { ...base.constraints, maxRepaymentUnits: units },
    })
    assert.equal(result.success, false, `expected ${JSON.stringify(units)} to be rejected`)
  }
})

test("a grid task cannot borrow the health category's constraints", () => {
  const base = healthTask()
  const result = taskSpec.safeParse({ ...base, category: "grid" })
  assert.equal(result.success, false)
})

test("a rebalancing task preserves separate token budgets and exact tick-width constraints", () => {
  const parsed = taskSpec.parse(rebalancingTask())
  assert.equal(parsed.category, "rebalancing")
  if (parsed.category !== "rebalancing") assert.fail("expected rebalancing task")
  assert.equal(parsed.constraints.token0BudgetUnits, "1000000")
  assert.equal(parsed.constraints.token1BudgetUnits, "2000000000000000")
  assert.equal(parsed.constraints.minimumRangeWidthTicks, 100)
  assert.equal(parsed.constraints.targetRangeWidthTicks, 200)
  assert.equal(parsed.constraints.maximumRangeWidthTicks, 300)
})

test("a rebalancing task rejects basis-point aliases and inconsistent tick widths", () => {
  assert.equal(taskSpec.safeParse(rebalancingTask({ rangeWidthBps: 200 })).success, false)
  assert.equal(taskSpec.safeParse(rebalancingTask({ tokenBudgetUnits: "1" })).success, false)
  assert.equal(taskSpec.safeParse(rebalancingTask({ targetRangeWidthTicks: 50 })).success, false)
  assert.equal(taskSpec.safeParse(rebalancingTask({ targetRangeWidthTicks: 350 })).success, false)
})
