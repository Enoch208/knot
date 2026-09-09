import { test } from "node:test"
import assert from "node:assert/strict"
import { CROSS_NETWORK_EXECUTION_REFUSED, taskSpec } from "../../packages/contracts/src/task.ts"

const U_TESTNET = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384"
const BORROWER = "0x1111111111111111111111111111111111111111"

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
