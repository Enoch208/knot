import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { keccak256, stringToHex } from "viem"
import {
  buildValidatedShieldRuns,
  evaluateShieldDataset,
  shieldEvaluationRuns,
  shieldGroundTruthDataset,
  shieldManualValidation,
  shieldSlitherOutput,
  ShieldMeasurementError,
  verifyPublishedShieldMeasurement,
} from "../../../packages/services/shield/index.ts"

type JsonObject = Record<string, unknown>

function assertObject(value: unknown): asserts value is JsonObject {
  assert.equal(typeof value, "object")
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}

function readUnknown(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown
}

function measurementInputs(): {
  validation: ReturnType<typeof shieldManualValidation.parse>
  rawOutputs: Map<string, unknown>
} {
  const validation = shieldManualValidation.parse(readUnknown("evidence/shield/corpus-v1/manual-validation.json"))
  const rawOutputs = new Map<string, unknown>()
  for (const fixture of validation.fixtures) rawOutputs.set(fixture.rawOutputPath, readUnknown(fixture.rawOutputPath))
  return { validation, rawOutputs }
}

function publishedMeasurementInputs(): Parameters<typeof verifyPublishedShieldMeasurement>[0] {
  const captureText = readFileSync("evidence/shield/corpus-v1/raw/capture.json", "utf8")
  const capture: unknown = JSON.parse(captureText)
  assertObject(capture)
  assert.ok(Array.isArray(capture.outputs))
  const rawOutputTexts = new Map<string, string>()
  for (const output of capture.outputs) {
    assertObject(output)
    rawOutputTexts.set(String(output.path), readFileSync(String(output.path), "utf8"))
  }
  return {
    captureText,
    validationText: readFileSync("evidence/shield/corpus-v1/manual-validation.json", "utf8"),
    rawOutputTexts,
    runsText: readFileSync("evidence/shield/corpus-v1/runs.json", "utf8"),
    evaluation: readUnknown("evidence/shield/corpus-v1/evaluation.json"),
    groundTruthText: readFileSync("tests/fixtures/shield/corpus-v1/ground-truth.json", "utf8"),
  }
}

describe("Shield measured frozen-corpus run", () => {
  test("preserves all six successful Slither outputs and all nineteen signals", () => {
    const capture = readUnknown("evidence/shield/corpus-v1/raw/capture.json")
    assertObject(capture)
    assertObject(capture.analyzer)
    assert.ok(Array.isArray(capture.outputs))
    assert.equal(capture.analyzer.name, "slither")
    assert.equal(capture.analyzer.version, "0.11.3")
    assert.equal(capture.analyzer.detectorCount, 100)
    assert.equal(capture.outputs.length, 6)
    let detectorCount = 0
    for (const value of capture.outputs) {
      assertObject(value)
      const text = readFileSync(String(value.path), "utf8")
      assert.equal(keccak256(stringToHex(text)), value.contentHash)
      assert.equal(text.includes("/Users/"), false)
      assert.equal(text.includes("/tmp/"), false)
      const raw = shieldSlitherOutput.parse(JSON.parse(text) as unknown)
      assert.equal(raw.success, true)
      assert.equal(raw.results.detectors.length, value.detectorCount)
      detectorCount += raw.results.detectors.length
    }
    assert.equal(detectorCount, 19)
  })

  test("binds every raw signal to exactly one manual decision before conversion", () => {
    const { validation, rawOutputs } = measurementInputs()
    const signals = validation.fixtures.flatMap((fixture) => fixture.signals)
    const runs = buildValidatedShieldRuns(validation, rawOutputs)
    const preserved = shieldEvaluationRuns.parse(readUnknown("evidence/shield/corpus-v1/runs.json"))

    assert.equal(validation.groundTruthSuppliedToAnalyzer, false)
    assert.equal(signals.length, 19)
    assert.equal(signals.filter((signal) => signal.decision === "confirmed").length, 2)
    assert.equal(signals.filter((signal) => signal.decision === "rejected").length, 2)
    assert.equal(signals.filter((signal) => signal.decision === "out_of_scope").length, 15)
    assert.equal(runs.runs.flatMap((run) => run.artifact.findings).length, 2)
    assert.equal(runs.runs.flatMap((run) => run.artifact.negativeControls).length, 2)
    assert.deepEqual(runs, preserved)
  })

  test("reproduces every aggregate and holdout result without hiding misses", () => {
    const { validation, rawOutputs } = measurementInputs()
    const runs = buildValidatedShieldRuns(validation, rawOutputs)
    const dataset = shieldGroundTruthDataset.parse(readUnknown("tests/fixtures/shield/corpus-v1/ground-truth.json"))
    const report = evaluateShieldDataset(dataset, runs)
    const preserved = readUnknown("evidence/shield/corpus-v1/evaluation.json")
    assertObject(preserved)

    assert.deepEqual(report, preserved.report)
    assert.deepEqual(report.counts, {
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 7,
      criticalCaseMisses: 0,
      severityValid: 2,
      severityInvalid: 0,
      negativeControlViolations: 0,
    })
    assert.deepEqual(report.precision, { numerator: 2, denominator: 2, decimal: "1.000000" })
    assert.deepEqual(report.recall, { numerator: 2, denominator: 9, decimal: "0.222222" })
    assert.deepEqual(report.severityValidity, { numerator: 2, denominator: 2, decimal: "1.000000" })
    const holdout = report.fixtures.find((fixture) => fixture.role === "holdout")
    assert.ok(holdout)
    assert.deepEqual(holdout.counts, {
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 3,
      criticalCaseMisses: 0,
      severityValid: 0,
      severityInvalid: 0,
      negativeControlViolations: 0,
    })
    assert.deepEqual(holdout.missedTruthIds, [
      "transparent-proxy-admin-slot",
      "transparent-proxy-upgrade-authority",
      "transparent-proxy-controlled-delegatecall",
    ])
  })

  test("refuses raw-signal drift and incomplete manual review", () => {
    const changedRaw = measurementInputs()
    const first = changedRaw.validation.fixtures[0]!
    const raw = shieldSlitherOutput.parse(changedRaw.rawOutputs.get(first.rawOutputPath))
    raw.results.detectors[0]!.check = "changed-detector"
    changedRaw.rawOutputs.set(first.rawOutputPath, raw)
    assert.throws(
      () => buildValidatedShieldRuns(changedRaw.validation, changedRaw.rawOutputs),
      (error: unknown) => error instanceof ShieldMeasurementError && error.code === "VALIDATION_MISMATCH",
    )

    const incomplete = measurementInputs()
    incomplete.validation.fixtures[0]!.signals.pop()
    assert.throws(
      () => buildValidatedShieldRuns(incomplete.validation, incomplete.rawOutputs),
      (error: unknown) => error instanceof ShieldMeasurementError && error.code === "VALIDATION_MISMATCH",
    )
  })

  test("refuses tampered published runs even when they remain valid JSON", () => {
    const input = publishedMeasurementInputs()
    const runs = JSON.parse(input.runsText) as JsonObject
    assert.ok(Array.isArray(runs.runs))
    const first = runs.runs[0]
    assertObject(first)
    assertObject(first.artifact)
    first.artifact.status = "PARTIAL"
    input.runsText = `${JSON.stringify(runs, null, 2)}\n`
    assert.throws(
      () => verifyPublishedShieldMeasurement(input),
      (error: unknown) => error instanceof ShieldMeasurementError && error.code === "PUBLISHED_EVIDENCE_MISMATCH",
    )
  })

  test("refuses a flattering edit to the published evaluation report", () => {
    const input = publishedMeasurementInputs()
    assertObject(input.evaluation)
    assertObject(input.evaluation.report)
    assertObject(input.evaluation.report.counts)
    input.evaluation.report.counts.falseNegatives = 0
    assert.throws(
      () => verifyPublishedShieldMeasurement(input),
      (error: unknown) => error instanceof ShieldMeasurementError && error.code === "PUBLISHED_EVIDENCE_MISMATCH",
    )
  })
})
