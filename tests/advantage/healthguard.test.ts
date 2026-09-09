import assert from "node:assert/strict"
import test from "node:test"
import { HealthGuardIndependentEvaluator } from "../../packages/advantage/src/healthguard.ts"
import { runPairedExperiment } from "../../packages/advantage/src/runner.ts"
import { experimentFixture } from "./fixture.ts"

test("HealthGuard hook scores both paths against independent integer math", async () => {
  const fixture = experimentFixture()
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [
    new HealthGuardIndependentEvaluator(),
  ])
  const dimensions = new Map(record.evaluation.dimensions.map((dimension) => [dimension.id, dimension]))
  assert.equal(dimensions.get("contract_integrity")?.agent.scoreBps, 10_000)
  assert.equal(dimensions.get("contract_integrity")?.baseline.scoreBps, 10_000)
  assert.equal(dimensions.get("deterministic_math")?.agent.scoreBps, 10_000)
  assert.equal(dimensions.get("deterministic_math")?.baseline.scoreBps, 0)
  assert.equal(dimensions.get("bounded_recommendation")?.agent.scoreBps, 10_000)
})

test("HealthGuard hook fails a malformed artifact closed", async () => {
  const fixture = experimentFixture()
  const invalid = new TextEncoder().encode(JSON.stringify({ status: "ASSESSED" }))
  fixture.store.values.set(fixture.input.agentPath.artifact.uri, invalid)
  fixture.input.agentPath.artifact.byteLength = invalid.byteLength
  const { createHash } = await import("node:crypto")
  fixture.input.agentPath.artifact.sha256 = createHash("sha256").update(invalid).digest("hex")
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [
    new HealthGuardIndependentEvaluator(),
  ])
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 0), true)
})
