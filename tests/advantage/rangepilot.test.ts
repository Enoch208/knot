import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { deriveRangePilotExpected, rangeProposalBounds } from "../../packages/advantage/src/rangepilot-reference.ts"
import { rangeAmountsForLiquidity, rangeSqrtRatioAtTick } from "../../packages/advantage/src/rangepilot-tick-math.ts"
import { RangePilotIndependentEvaluator } from "../../packages/advantage/src/rangepilot.ts"
import { AdvantageValidationError, runPairedExperiment, validatePairedExperiment } from "../../packages/advantage/src/runner.ts"
import type { EvidenceReference } from "../../packages/advantage/src/schemas.ts"
import type { EvidenceStore } from "./fixture.ts"
import { rangeExperimentFixture } from "./rangepilot-fixture.ts"

const evaluator = new RangePilotIndependentEvaluator()

test("RangePilot independently reproduces tick alignment, rounded amounts, checks, and proposal selection", async () => {
  const fixture = rangeExperimentFixture()
  assert.equal(rangeSqrtRatioAtTick(0), 79228162514264337593543950336n)
  assert.deepEqual(rangeProposalBounds(fixture.request), { lower: 50, upper: 250 })
  assert.deepEqual(rangeAmountsForLiquidity(1_000_000_000_000_000_000n, rangeSqrtRatioAtTick(150), 50, 250), {
    amount0: 4_950_009_303_363_817n,
    amount1: 5_024_815_345_452_263n,
  })
  const expected = deriveRangePilotExpected(fixture.request, new Date("2026-09-09T10:00:10.000Z"))
  assert.equal(expected.status, "ANALYZED")
  assert.equal(expected.decision, "PROPOSE_RANGE")
  assert.equal(expected.proposal?.checks.every((check) => check.passed), true)
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.comparison.winner, "tie")
  assert.equal(record.comparison.ties, 6)
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000), true)
})

test("RangePilot independently classifies an in-range position as hold", () => {
  const fixture = rangeExperimentFixture()
  fixture.request.snapshot.pool.currentTick = 0
  fixture.request.snapshot.pool.sqrtPriceX96 = "79228162514264337593543950336"
  const expected = deriveRangePilotExpected(fixture.request, new Date("2026-09-09T10:00:10.000Z"))
  assert.equal(expected.status, "ANALYZED")
  assert.equal(expected.reasonCode, "IN_RANGE_HOLD")
  assert.equal(expected.decision, "HOLD")
  assert.equal(expected.currentState?.condition, "IN_RANGE")
  assert.equal(expected.proposal, null)
})

test("RangePilot independently refuses unsafe identity, stale evidence, and missing gas", () => {
  const identity = rangeExperimentFixture().request
  identity.snapshot.account.canManagePosition = false
  assert.equal(deriveRangePilotExpected(identity, new Date("2026-09-09T10:00:10.000Z")).reasonCode, "AUTHORITY_MISMATCH")

  const stale = rangeExperimentFixture().request
  stale.snapshot.canonicality = "orphaned"
  assert.equal(deriveRangePilotExpected(stale, new Date("2026-09-09T10:00:10.000Z")).status, "STALE_SNAPSHOT")

  const gas = rangeExperimentFixture().request
  gas.snapshot.gasEstimate = null
  const expected = deriveRangePilotExpected(gas, new Date("2026-09-09T10:00:10.000Z"))
  assert.equal(expected.status, "PLAN_REJECTED")
  assert.equal(expected.decision, "REFUSED")
  assert.equal(expected.proposal?.checks.find((check) => check.code === "GAS_BUDGET")?.passed, false)
})

test("RangePilot scores altered classification, ticks, amounts, constraints, and decision independently", async () => {
  const cases: Array<{ dimension: string; mutate: (artifact: Record<string, unknown>) => void }> = [
    { dimension: "position_classification", mutate: (artifact) => state(artifact).condition = "IN_RANGE" },
    { dimension: "tick_range_feasibility", mutate: (artifact) => proposal(artifact).tickLower = 51 },
    { dimension: "amount_and_budget_math", mutate: (artifact) => proposal(artifact).amount0Units = "1" },
    { dimension: "constraint_refusals", mutate: (artifact) => proposal(artifact).gasEstimateWei = "1" },
    { dimension: "bounded_decision", mutate: (artifact) => artifact.decision = "HOLD" },
  ]
  for (const item of cases) {
    const fixture = rangeExperimentFixture()
    const artifact = readJson(fixture.store, fixture.input.agentPath.artifact)
    item.mutate(artifact)
    replace(fixture.store, fixture.input.agentPath.artifact, artifact)
    const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
    assert.equal(record.evaluation.dimensions.find((dimension) => dimension.id === item.dimension)?.agent.scoreBps, 0, item.dimension)
  }
})

test("RangePilot rejects a changed source hash that is no longer task-bound", async () => {
  const fixture = rangeExperimentFixture()
  const request = readJson(fixture.store, fixture.input.input)
  const snapshot = request.snapshot as { sources: Array<Record<string, unknown>> }
  snapshot.sources[0]!.contentHash = `0x${"f".repeat(64)}`
  replace(fixture.store, fixture.input.input, request)
  fixture.input.agentPath.inputIdentity.inputSha256 = fixture.input.input.sha256
  fixture.input.baselinePath.inputIdentity.inputSha256 = fixture.input.input.sha256
  await assert.rejects(
    runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "INPUT_MISMATCH",
  )
})

test("RangePilot binds every marketplace constraint to the raw seller request without aliases", async () => {
  const mutations: Array<[string, unknown]> = [
    ["token0BudgetUnits", "1"],
    ["token1BudgetUnits", "2"],
    ["minimumRangeWidthTicks", 50],
    ["targetRangeWidthTicks", 250],
    ["maximumRangeWidthTicks", 350],
    ["maximumSlippageBps", 51],
    ["gasBudgetWei", "499999999999999"],
    ["cooldownSeconds", 301],
    ["executionMode", "reviewed"],
  ]
  for (const [field, value] of mutations) {
    const fixture = rangeExperimentFixture()
    const task = readJson(fixture.store, fixture.input.task)
    const constraints = task.constraints as Record<string, unknown>
    constraints[field] = value
    replace(fixture.store, fixture.input.task, task)
    await assert.rejects(
      runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator]),
      (error) => error instanceof AdvantageValidationError && error.code === "INPUT_MISMATCH",
      field,
    )
  }
})

test("RangePilot fails malformed artifacts closed", async () => {
  const fixture = rangeExperimentFixture()
  replace(fixture.store, fixture.input.agentPath.artifact, { status: "ANALYZED", profit: 99 })
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 0), true)
})

test("RangePilot evidence cannot assert timing, costs, or winners manually", async () => {
  const timing = rangeExperimentFixture()
  timing.input.agentPath.observation.durationMs += 1
  await assert.rejects(runPairedExperiment(timing.input, timing.store.resolver, [evaluator]))

  const cost = rangeExperimentFixture()
  cost.input.agentPath.costs[0]!.amount.units = "2"
  await assert.rejects(
    runPairedExperiment(cost.input, cost.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "COST_UNVERIFIABLE",
  )

  const winner = rangeExperimentFixture()
  const record = await runPairedExperiment(winner.input, winner.store.resolver, [evaluator])
  record.comparison.winner = "agent"
  record.comparison.agentWins = 1
  record.comparison.ties = 5
  record.comparison.decisiveDimensionId = "contract_integrity"
  await assert.rejects(validatePairedExperiment(record, winner.store.resolver, [evaluator]))
})

function state(artifact: Record<string, unknown>): Record<string, unknown> {
  return artifact.currentState as Record<string, unknown>
}

function proposal(artifact: Record<string, unknown>): Record<string, unknown> {
  return artifact.proposal as Record<string, unknown>
}

function readJson(store: EvidenceStore, reference: EvidenceReference): Record<string, unknown> {
  const bytes = store.values.get(reference.uri)
  assert.ok(bytes)
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

function replace(store: EvidenceStore, reference: EvidenceReference, value: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  store.values.set(reference.uri, bytes)
  reference.byteLength = bytes.byteLength
  reference.sha256 = createHash("sha256").update(bytes).digest("hex")
}
