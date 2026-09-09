import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { gridAllocateUnits, gridArithmeticLevels, gridGeometricLevels, gridQuoteToBase } from "../../packages/advantage/src/gridquant-math.ts"
import { deriveGridQuantExpected } from "../../packages/advantage/src/gridquant-reference.ts"
import { GridQuantIndependentEvaluator } from "../../packages/advantage/src/gridquant.ts"
import { AdvantageValidationError, runPairedExperiment, validatePairedExperiment } from "../../packages/advantage/src/runner.ts"
import type { EvidenceReference } from "../../packages/advantage/src/schemas.ts"
import type { EvidenceStore } from "./fixture.ts"
import { gridExperimentFixture } from "./gridquant-fixture.ts"

const evaluator = new GridQuantIndependentEvaluator()

test("GridQuant independently reproduces levels, allocations, inventory, fees, and plan selection", async () => {
  const fixture = gridExperimentFixture()
  assert.deepEqual(gridArithmeticLevels(50_000n, 80_000n, 4), [50_000n, 60_000n, 70_000n, 80_000n])
  assert.deepEqual(gridAllocateUnits(10n, 4), [3n, 3n, 2n, 2n])
  assert.equal(gridQuoteToBase(250_000_000_000_000_000_000n, 50_000n, 2, 18, 18), 500_000_000_000_000_000n)
  const expected = deriveGridQuantExpected(fixture.request, new Date("2026-09-09T10:00:10.000Z"))
  assert.equal(expected.status, "ANALYZED")
  assert.equal(expected.result?.outcome, "PLAN")
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.comparison.winner, "tie")
  assert.equal(record.comparison.ties, 5)
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000), true)
})

test("GridQuant independently constructs geometric levels", () => {
  assert.deepEqual(gridGeometricLevels(100n, 900n, 3), [100n, 300n, 900n])
  const fixture = gridExperimentFixture()
  fixture.request.task.parameters.lowerPriceUnits = "100"
  fixture.request.task.parameters.upperPriceUnits = "900"
  fixture.request.task.parameters.gridCount = 3
  fixture.request.task.parameters.spacing = "geometric"
  fixture.request.task.parameters.maxBaseInventoryUnits = "100000000000000000000000"
  const expected = deriveGridQuantExpected(fixture.request, new Date("2026-09-09T10:00:10.000Z"))
  assert.equal(expected.result?.outcome, "PLAN")
  if (expected.result?.outcome === "PLAN") assert.deepEqual(expected.result.levels.map((level) => level.priceUnits), ["100", "300", "900"])
})

test("GridQuant independently derives no-action and refusal outcomes", () => {
  const expired = gridExperimentFixture().request
  expired.task.parameters.expiryUtc = "2026-09-09T10:00:10.000Z"
  assert.equal(deriveGridQuantExpected(expired, new Date("2026-09-09T10:00:10.000Z")).reasonCode, "EXPIRED")

  const gas = gridExperimentFixture().request
  gas.snapshot.gasEstimate!.estimatedNetworkFeeQuoteUnitsPerSwap = "1"
  assert.equal(deriveGridQuantExpected(gas, new Date("2026-09-09T10:00:10.000Z")).reasonCode, "GAS_EVIDENCE_MISMATCH")

  const inventory = gridExperimentFixture().request
  inventory.task.parameters.maxBaseInventoryUnits = "1"
  assert.equal(deriveGridQuantExpected(inventory, new Date("2026-09-09T10:00:10.000Z")).reasonCode, "MAX_INVENTORY_EXCEEDED")

  const pool = gridExperimentFixture().request
  pool.snapshot.pair.pool = "0x9999999999999999999999999999999999999999"
  assert.equal(deriveGridQuantExpected(pool, new Date("2026-09-09T10:00:10.000Z")).reasonCode, "SNAPSHOT_PAIR_MISMATCH")
})

test("GridQuant scores altered levels, allocation, fees, and decision independently", async () => {
  const cases: Array<{ dimension: string; mutate: (artifact: Record<string, unknown>) => void }> = [
    { dimension: "grid_level_math", mutate: (artifact) => levels(artifact)[1]!.priceUnits = "60001" },
    { dimension: "allocation_and_inventory", mutate: (artifact) => levels(artifact)[0]!.allocatedQuoteUnits = "1" },
    { dimension: "fee_and_spread_feasibility", mutate: (artifact) => result(artifact).fees = { ...result(artifact).fees as object, conservativeBreakEvenBps: "1" } },
    { dimension: "bounded_decision", mutate: (artifact) => artifact.status = "PLAN_REJECTED" },
  ]
  for (const item of cases) {
    const fixture = gridExperimentFixture()
    const artifact = readJson(fixture.store, fixture.input.agentPath.artifact)
    item.mutate(artifact)
    replace(fixture.store, fixture.input.agentPath.artifact, artifact)
    const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
    assert.equal(record.evaluation.dimensions.find((dimension) => dimension.id === item.dimension)?.agent.scoreBps, 0, item.dimension)
  }
})

test("GridQuant rejects a changed source hash that is no longer task-bound", async () => {
  const fixture = gridExperimentFixture()
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

test("GridQuant rejects a marketplace task that differs from the seller request", async () => {
  const fixture = gridExperimentFixture()
  const task = readJson(fixture.store, fixture.input.task)
  const constraints = task.constraints as Record<string, unknown>
  constraints.gridCount = 5
  replace(fixture.store, fixture.input.task, task)
  await assert.rejects(
    runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "INPUT_MISMATCH",
  )
})

test("GridQuant detects a manifest whose response no longer matches the artifact", async () => {
  const fixture = gridExperimentFixture()
  const raw = readJson(fixture.store, fixture.input.agentPath.rawOutput)
  const response = raw.response as Record<string, unknown>
  response.content = JSON.stringify({ status: "ANALYZED", result: { outcome: "PLAN", levels: [] } })
  replace(fixture.store, fixture.input.agentPath.rawOutput, raw)
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.evaluation.dimensions.find((dimension) => dimension.id === "contract_integrity")?.agent.scoreBps, 0)
})

test("GridQuant rejects manifest bytes that no longer match their evidence hash", async () => {
  const fixture = gridExperimentFixture()
  fixture.store.values.set(fixture.input.agentPath.rawOutput.uri, new TextEncoder().encode("{}"))
  await assert.rejects(
    runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
})

test("GridQuant fails malformed artifacts closed", async () => {
  const fixture = gridExperimentFixture()
  replace(fixture.store, fixture.input.agentPath.artifact, { status: "ANALYZED", projectedProfit: 99 })
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 0), true)
})

test("GridQuant evidence cannot assert timing, costs, or winners manually", async () => {
  const timing = gridExperimentFixture()
  timing.input.agentPath.observation.durationMs += 1
  await assert.rejects(runPairedExperiment(timing.input, timing.store.resolver, [evaluator]))

  const cost = gridExperimentFixture()
  cost.input.agentPath.costs[0]!.amount.units = "2"
  await assert.rejects(
    runPairedExperiment(cost.input, cost.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "COST_UNVERIFIABLE",
  )

  const winner = gridExperimentFixture()
  const record = await runPairedExperiment(winner.input, winner.store.resolver, [evaluator])
  record.comparison.winner = "agent"
  record.comparison.agentWins = 1
  record.comparison.ties = 4
  record.comparison.decisiveDimensionId = "contract_integrity"
  await assert.rejects(validatePairedExperiment(record, winner.store.resolver, [evaluator]))
})

function result(artifact: Record<string, unknown>): Record<string, unknown> {
  return artifact.result as Record<string, unknown>
}

function levels(artifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return result(artifact).levels as Array<Record<string, unknown>>
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
