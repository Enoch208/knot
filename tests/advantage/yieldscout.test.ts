import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { deriveYieldExpected, normalizeYieldRate, calculateYieldHorizonBenefit } from "../../packages/advantage/src/yieldscout-reference.ts"
import { YieldScoutIndependentEvaluator } from "../../packages/advantage/src/yieldscout.ts"
import { AdvantageValidationError, runPairedExperiment, validatePairedExperiment } from "../../packages/advantage/src/runner.ts"
import type { EvidenceReference } from "../../packages/advantage/src/schemas.ts"
import { yieldExperimentFixture } from "./yieldscout-fixture.ts"
import type { EvidenceStore } from "./fixture.ts"

const evaluator = new YieldScoutIndependentEvaluator()

test("YieldScout independently reproduces rates, benefits, costs, exclusions, and migration selection", async () => {
  const fixture = yieldExperimentFixture()
  assert.equal(normalizeYieldRate("5000000000000000000", "10512000"), 52_560_000_000_000_000_000_000_000n)
  assert.equal(calculateYieldHorizonBenefit("1000000000", 52_560_000_000_000_000_000_000_000n, 2592000), 4_320_000n)
  const expected = deriveYieldExpected(fixture.request, new Date("2026-09-09T10:00:11.000Z"))
  assert.equal(expected.status, "ASSESSED")
  assert.equal(expected.selectedMarketId, "aave-usdc")
  assert.deepEqual(expected.excludedMarkets[0]?.reasons, [
    "risk flags are active: INCIDENT_ACTIVE",
    "available liquidity is below requirement",
    "remaining supply capacity is insufficient",
    "concentration exceeds cap",
  ])
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.comparison.winner, "tie")
  assert.equal(record.comparison.ties, 5)
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000), true)
})

test("YieldScout independently derives a cost-dominated hold", () => {
  const fixture = yieldExperimentFixture()
  const request = structuredClone(fixture.request)
  const destination = request.snapshot.markets.find((market) => market.marketId === "aave-usdc")
  assert.ok(destination)
  destination.entryCostUnits = "3000000"
  destination.exitCostUnits = "3000000"
  request.gasAllowanceUnits = "10000000"
  const expected = deriveYieldExpected(request, new Date("2026-09-09T10:00:11.000Z"))
  assert.equal(expected.status, "NO_ACTION")
  assert.equal(expected.reasonCode, "COSTS_DOMINATE")
  assert.equal(expected.recommendation, "HOLD")
  assert.equal(expected.selectedMarketId, "venus-usdc")
})

test("YieldScout fails closed when cost provenance is unavailable", () => {
  const fixture = yieldExperimentFixture()
  const request = structuredClone(fixture.request)
  request.snapshot.costValuation = {
    status: "unknown",
    asset: request.asset,
    observedAtUtc: null,
    source: null,
  }
  const expected = deriveYieldExpected(request, new Date("2026-09-09T10:00:11.000Z"))
  assert.equal(expected.status, "ASSESSMENT_INCOMPLETE")
  assert.equal(expected.reasonCode, "COST_VALUATION_UNKNOWN")
  assert.equal(expected.recommendation, "REFUSED")
  assert.equal(expected.selectedMarketId, null)
  assert.deepEqual(expected.eligibleMarkets, [])
  assert.deepEqual(expected.excludedMarkets, [
    { marketId: "venus-usdc", reasons: ["migration cost valuation is unknown"] },
  ])
})

test("YieldScout scores altered rate, cost, exclusion, and selection evidence independently", async () => {
  const cases: Array<{ dimension: string; mutate: (artifact: Record<string, unknown>) => void }> = [
    {
      dimension: "rate_and_horizon_math",
      mutate: (artifact) => {
        const rows = artifact.eligibleMarkets as Array<Record<string, unknown>>
        rows[1]!.baseAnnualRateRay = "1"
      },
    },
    {
      dimension: "disclosed_cost_math",
      mutate: (artifact) => {
        const rows = artifact.eligibleMarkets as Array<Record<string, unknown>>
        rows[1]!.netBenefitUnits = "999999999"
      },
    },
    {
      dimension: "market_exclusions",
      mutate: (artifact) => {
        artifact.excludedMarkets = [{ marketId: "venus-risky", reasons: ["risk flags are active: INCIDENT_ACTIVE"] }]
      },
    },
    {
      dimension: "bounded_selection",
      mutate: (artifact) => {
        artifact.status = "NO_ACTION"
        artifact.reasonCode = "COSTS_DOMINATE"
        artifact.recommendation = "HOLD"
        artifact.selectedMarketId = "venus-usdc"
      },
    },
  ]
  for (const item of cases) {
    const fixture = yieldExperimentFixture()
    const artifact = readJson(fixture.store, fixture.input.agentPath.artifact)
    item.mutate(artifact)
    replace(fixture.store, fixture.input.agentPath.artifact, artifact)
    const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
    const score = record.evaluation.dimensions.find((dimension) => dimension.id === item.dimension)?.agent.scoreBps
    assert.equal(score, 0, item.dimension)
  }
})

test("YieldScout rejects source bytes that are no longer bound to the task hash", async () => {
  const fixture = yieldExperimentFixture()
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

test("YieldScout rejects a task whose marketplace constraints do not bind the seller request", async () => {
  const fixture = yieldExperimentFixture()
  const task = readJson(fixture.store, fixture.input.task)
  const constraints = task.constraints as Record<string, unknown>
  constraints.allowedProtocols = ["venus"]
  replace(fixture.store, fixture.input.task, task)
  await assert.rejects(
    runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "INPUT_MISMATCH",
  )
})

test("YieldScout fails a malformed artifact closed", async () => {
  const fixture = yieldExperimentFixture()
  replace(fixture.store, fixture.input.agentPath.artifact, { status: "ASSESSED", apy: 99 })
  const record = await runPairedExperiment(fixture.input, fixture.store.resolver, [evaluator])
  assert.equal(record.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 0), true)
})

test("YieldScout evidence cannot assert timing, cost, or winner fields manually", async () => {
  const timing = yieldExperimentFixture()
  timing.input.agentPath.observation.durationMs += 1
  await assert.rejects(runPairedExperiment(timing.input, timing.store.resolver, [evaluator]))

  const cost = yieldExperimentFixture()
  cost.input.agentPath.costs[0]!.amount.units = "2"
  await assert.rejects(
    runPairedExperiment(cost.input, cost.store.resolver, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "COST_UNVERIFIABLE",
  )

  const winner = yieldExperimentFixture()
  const record = await runPairedExperiment(winner.input, winner.store.resolver, [evaluator])
  record.comparison.winner = "agent"
  record.comparison.agentWins = 1
  record.comparison.ties = 4
  record.comparison.decisiveDimensionId = "contract_integrity"
  await assert.rejects(validatePairedExperiment(record, winner.store.resolver, [evaluator]))
})

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
