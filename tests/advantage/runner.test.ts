import assert from "node:assert/strict"
import test from "node:test"
import { HealthGuardIndependentEvaluator } from "../../packages/advantage/src/healthguard.ts"
import {
  AdvantageValidationError,
  runPairedExperiment,
  validateExperimentDataset,
  validatePairedExperiment,
} from "../../packages/advantage/src/runner.ts"
import { pairedExperimentInput, pairedExperimentRecord } from "../../packages/advantage/src/schemas.ts"
import { experimentFixture } from "./fixture.ts"

const evaluator = new HealthGuardIndependentEvaluator()

test("derives a paired outcome from independently evaluated raw artifacts", async () => {
  const { input, store } = experimentFixture()
  const record = await runPairedExperiment(input, store.resolver, [evaluator])
  assert.equal(record.comparison.winner, "agent")
  assert.equal(record.comparison.agentWins, 1)
  assert.equal(record.comparison.baselineWins, 0)
  assert.equal(record.comparison.ties, 3)
  assert.equal(record.comparison.decisiveDimensionId, "deterministic_math")
  assert.equal(pairedExperimentRecord.safeParse(record).success, true)
  assert.deepEqual(await validatePairedExperiment(record, store.resolver, [evaluator]), record)
  const dataset = {
    schemaVersion: "knot.advantage.dataset/1",
    generatedAtUtc: "2026-09-09T10:01:00.000Z",
    experiments: [record],
  }
  assert.deepEqual(await validateExperimentDataset(dataset, store.resolver, [evaluator]), dataset)
})

test("refuses a missing raw output and a content hash mismatch", async () => {
  const missing = experimentFixture()
  missing.store.values.delete(missing.input.agentPath.rawOutput.uri)
  await assert.rejects(
    runPairedExperiment(missing.input, missing.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "MISSING_EVIDENCE",
  )
  const mismatched = experimentFixture()
  mismatched.input.agentPath.artifact.sha256 = "f".repeat(64)
  await assert.rejects(
    runPairedExperiment(mismatched.input, mismatched.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
})

test("refuses paths that did not observe the identical task input", async () => {
  const { input, store } = experimentFixture()
  input.baselinePath.inputIdentity.inputSha256 = "e".repeat(64)
  await assert.rejects(
    runPairedExperiment(input, store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "INPUT_MISMATCH",
  )
})

test("refuses unverifiable or contradictory cost evidence", async () => {
  const claimed = experimentFixture()
  claimed.input.agentPath.costs[0]!.provenance.evidenceClass = "publisher_claim"
  await assert.rejects(
    runPairedExperiment(claimed.input, claimed.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "COST_UNVERIFIABLE",
  )
  const contradictory = experimentFixture()
  contradictory.input.agentPath.costs[0]!.amount.units = "2"
  await assert.rejects(
    runPairedExperiment(contradictory.input, contradictory.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "COST_UNVERIFIABLE",
  )
  const mislabeled = experimentFixture()
  mislabeled.input.evidenceClass = "testnet_observation"
  await assert.rejects(
    runPairedExperiment(mislabeled.input, mislabeled.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
})

test("rejects manually supplied or rewritten winners and scores", async () => {
  const fixture = experimentFixture()
  assert.equal(pairedExperimentInput.safeParse({ ...fixture.input, comparison: { winner: "agent" } }).success, false)
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  const rewrittenWinner = structuredClone(record)
  rewrittenWinner.comparison.winner = "baseline"
  await assert.rejects(validatePairedExperiment(rewrittenWinner, fixture.store.resolver, [evaluator]))
  const rewrittenScores = structuredClone(record)
  const dimension = rewrittenScores.evaluation.dimensions[2]!
  dimension.agent.scoreBps = 0
  dimension.baseline.scoreBps = 10_000
  dimension.result = "baseline_win"
  rewrittenScores.comparison = {
    winner: "baseline",
    agentWins: 0,
    baselineWins: 1,
    ties: 3,
    decisiveDimensionId: "deterministic_math",
  }
  await assert.rejects(
    validatePairedExperiment(rewrittenScores, fixture.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVALUATION_MISMATCH",
  )
})

test("closed schemas reject unknown fields and invented duration", () => {
  const { input } = experimentFixture()
  assert.equal(pairedExperimentInput.safeParse({ ...input, unexpected: true }).success, false)
  const duration = structuredClone(input)
  duration.agentPath.observation.durationMs = 1
  assert.equal(pairedExperimentInput.safeParse(duration).success, false)
})
