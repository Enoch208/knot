import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { keccak256, stringToHex } from "viem"
import { z } from "zod"
import {
  buildValidatedShieldRuns,
  evaluateShieldDataset,
  shieldGroundTruthDataset,
  shieldManualValidation,
} from "../packages/services/shield/index.ts"

const captureSchema = z
  .object({
    schemaVersion: z.literal("knot.shield.slither-capture/1"),
    analyzer: z.object({ name: z.literal("slither"), version: z.literal("0.11.3"), detectorCount: z.literal(100) }).strict(),
    compiler: z.object({
      name: z.literal("solc"),
      version: z.literal("0.8.28"),
      optimizerEnabled: z.literal(true),
      optimizerRuns: z.literal(200),
      evmVersion: z.literal("paris"),
    }).strict(),
    commandTemplate: z.string().min(1),
    pathNormalization: z.string().min(1),
    outputs: z.array(z.object({
      fixtureId: z.string().min(1),
      path: z.string().min(1),
      contentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
      detectorCount: z.number().int().nonnegative(),
      processExitStatus: z.number().int().nullable(),
    }).strict()).min(6),
  })
  .strict()

const evidenceRoot = resolve("evidence/shield/corpus-v1")
const validationText = readFileSync(resolve(evidenceRoot, "manual-validation.json"), "utf8")
const validationInput: unknown = JSON.parse(validationText)
const validation = shieldManualValidation.parse(validationInput)
const captureText = readFileSync(resolve(evidenceRoot, "raw/capture.json"), "utf8")
const captureInput: unknown = JSON.parse(captureText)
const capture = captureSchema.parse(captureInput)
const rawOutputs = new Map<string, unknown>()

for (const output of capture.outputs) {
  const text = readFileSync(resolve(output.path), "utf8")
  assert.equal(keccak256(stringToHex(text)), output.contentHash)
  const parsed: unknown = JSON.parse(text)
  rawOutputs.set(output.path, parsed)
}

assert.deepEqual(
  [...rawOutputs.keys()].sort(),
  validation.fixtures.map((fixture) => fixture.rawOutputPath).sort(),
)

const runs = buildValidatedShieldRuns(validation, rawOutputs)
const runsText = `${JSON.stringify(runs, null, 2)}\n`
writeFileSync(resolve(evidenceRoot, "runs.json"), runsText)

const groundTruthText = readFileSync("tests/fixtures/shield/corpus-v1/ground-truth.json", "utf8")
const groundTruthInput: unknown = JSON.parse(groundTruthText)
const groundTruth = shieldGroundTruthDataset.parse(groundTruthInput)
const report = evaluateShieldDataset(groundTruth, runs)
const signals = validation.fixtures.flatMap((fixture) => fixture.signals)
const evaluation = {
  schemaVersion: "knot.shield.measured-evaluation/1",
  evaluatedAtUtc: "2026-09-09T10:57:29.000Z",
  datasetId: validation.datasetId,
  relationship: validation.assessorRelationship,
  groundTruthSuppliedToAnalyzer: validation.groundTruthSuppliedToAnalyzer,
  tooling: { analyzer: validation.analyzer, compiler: validation.compiler },
  preservedEvidence: {
    capturePath: "evidence/shield/corpus-v1/raw/capture.json",
    captureContentHash: keccak256(stringToHex(captureText)),
    manualValidationPath: "evidence/shield/corpus-v1/manual-validation.json",
    manualValidationContentHash: keccak256(stringToHex(validationText)),
    runsPath: "evidence/shield/corpus-v1/runs.json",
    runsContentHash: keccak256(stringToHex(runsText)),
    groundTruthPath: "tests/fixtures/shield/corpus-v1/ground-truth.json",
    groundTruthContentHash: keccak256(stringToHex(groundTruthText)),
  },
  rawSignalCounts: {
    total: signals.length,
    confirmed: signals.filter((signal) => signal.decision === "confirmed").length,
    rejected: signals.filter((signal) => signal.decision === "rejected").length,
    outOfScope: signals.filter((signal) => signal.decision === "out_of_scope").length,
  },
  report,
  limitations: [
    "all six fixtures, labels, and manual validation decisions are team-owned",
    "manual validation is part of the measured pipeline and rejected mapped analyzer signals before scoring",
    "the corpus is too small and synthetic to establish comprehensive audit quality",
    "the holdout result was scored without changing frozen sources, rules, labels, detector mappings, or Shield logic",
  ],
}
writeFileSync(resolve(evidenceRoot, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`)
