import { keccak256, stringToHex } from "viem"
import { z } from "zod"
import { address, hexDigest } from "../../contracts/src/primitives.ts"
import {
  hashShieldArtifact,
  shieldEvaluationReport,
  shieldEvaluationRuns,
  shieldGroundTruthDataset,
  evaluateShieldDataset,
  type ShieldEvaluationReport,
  type ShieldEvaluationRuns,
} from "./evaluate.ts"
import { shieldFinding, shieldRuleId } from "./schemas.ts"

const analyzerIdentity = z
  .object({
    name: z.literal("slither"),
    version: z.literal("0.11.3"),
    detectorCount: z.literal(100),
  })
  .strict()

const compilerIdentity = z
  .object({
    name: z.literal("solc"),
    version: z.literal("0.8.28"),
    optimizerEnabled: z.literal(true),
    optimizerRuns: z.literal(200),
    evmVersion: z.literal("paris"),
  })
  .strict()

const rawSourceMapping = z
  .object({
    filename_relative: z.string().min(1),
    lines: z.array(z.number().int().positive()).min(1),
  })
  .passthrough()

const rawElement = z
  .object({
    source_mapping: rawSourceMapping,
  })
  .passthrough()

const rawDetector = z
  .object({
    check: z.string().min(1),
    impact: z.string().min(1),
    confidence: z.string().min(1),
    elements: z.array(rawElement).min(1),
  })
  .passthrough()

export const shieldSlitherOutput = z
  .object({
    success: z.literal(true),
    error: z.null(),
    results: z.object({ detectors: z.array(rawDetector) }).passthrough(),
  })
  .passthrough()

const signalBase = z.object({
  signalIndex: z.number().int().nonnegative(),
  detectorCheck: z.string().min(1),
  detectorImpact: z.string().min(1),
  detectorConfidence: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceLines: z.array(z.number().int().positive()).min(1),
  rationale: z.string().min(1),
})

const reviewedSignal = z.discriminatedUnion("decision", [
  signalBase.extend({
    decision: z.literal("confirmed"),
    mappedRuleId: shieldRuleId,
    finding: shieldFinding,
  }).strict(),
  signalBase.extend({
    decision: z.literal("rejected"),
    mappedRuleId: shieldRuleId,
    finding: z.null(),
  }).strict(),
  signalBase.extend({
    decision: z.literal("out_of_scope"),
    mappedRuleId: z.null(),
    finding: z.null(),
  }).strict(),
])

const unresolved = z
  .object({
    check: z.string().min(1),
    reason: z.string().min(1),
    consequence: z.string().min(1),
  })
  .strict()

export const shieldManualValidation = z
  .object({
    schemaVersion: z.literal("knot.shield.manual-validation/1"),
    datasetId: z.string().min(1),
    analyzer: analyzerIdentity,
    compiler: compilerIdentity,
    assessorRelationship: z.string().min(1),
    groundTruthSuppliedToAnalyzer: z.literal(false),
    fixtures: z.array(
      z
        .object({
          fixtureId: z.string().min(1),
          rawOutputPath: z.string().min(1),
          targetAddress: address,
          sourceBundleHash: hexDigest,
          assessedAtUtc: z.iso.datetime(),
          signals: z.array(reviewedSignal),
          unresolved: z.array(unresolved),
          limitations: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ).min(6),
  })
  .strict()

export const shieldSlitherCapture = z
  .object({
    schemaVersion: z.literal("knot.shield.slither-capture/1"),
    analyzer: analyzerIdentity,
    compiler: compilerIdentity,
    commandTemplate: z.string().min(1),
    pathNormalization: z.string().min(1),
    outputs: z.array(z.object({
      fixtureId: z.string().min(1),
      path: z.string().min(1),
      contentHash: hexDigest,
      detectorCount: z.number().int().nonnegative(),
      processExitStatus: z.number().int().nullable(),
    }).strict()).min(6),
  })
  .strict()

export const shieldMeasuredEvaluation = z
  .object({
    schemaVersion: z.literal("knot.shield.measured-evaluation/1"),
    evaluatedAtUtc: z.iso.datetime(),
    datasetId: z.string().min(1),
    relationship: z.string().min(1),
    groundTruthSuppliedToAnalyzer: z.literal(false),
    tooling: z.object({ analyzer: analyzerIdentity, compiler: compilerIdentity }).strict(),
    preservedEvidence: z.object({
      capturePath: z.literal("evidence/shield/corpus-v1/raw/capture.json"),
      captureContentHash: hexDigest,
      manualValidationPath: z.literal("evidence/shield/corpus-v1/manual-validation.json"),
      manualValidationContentHash: hexDigest,
      runsPath: z.literal("evidence/shield/corpus-v1/runs.json"),
      runsContentHash: hexDigest,
      groundTruthPath: z.literal("tests/fixtures/shield/corpus-v1/ground-truth.json"),
      groundTruthContentHash: hexDigest,
    }).strict(),
    rawSignalCounts: z.object({
      total: z.number().int().nonnegative(),
      confirmed: z.number().int().nonnegative(),
      rejected: z.number().int().nonnegative(),
      outOfScope: z.number().int().nonnegative(),
    }).strict(),
    report: shieldEvaluationReport,
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()

export type ShieldManualValidation = z.infer<typeof shieldManualValidation>

export class ShieldMeasurementError extends Error {
  readonly code: "INVALID_VALIDATION" | "RAW_OUTPUT_MISSING" | "RAW_OUTPUT_MISMATCH" | "VALIDATION_MISMATCH" | "PUBLISHED_EVIDENCE_MISMATCH"

  constructor(code: ShieldMeasurementError["code"], message: string) {
    super(message)
    this.name = "ShieldMeasurementError"
    this.code = code
  }
}

export function verifyPublishedShieldMeasurement(input: {
  captureText: string
  validationText: string
  rawOutputTexts: ReadonlyMap<string, string>
  runsText: string
  evaluation: unknown
  groundTruthText: string
}): ShieldEvaluationReport {
  let captureInput: unknown
  let validationInput: unknown
  let groundTruthInput: unknown
  try {
    captureInput = JSON.parse(input.captureText) as unknown
    validationInput = JSON.parse(input.validationText) as unknown
    groundTruthInput = JSON.parse(input.groundTruthText) as unknown
  } catch {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield source evidence is not JSON")
  }
  const capture = shieldSlitherCapture.safeParse(captureInput)
  const validation = shieldManualValidation.safeParse(validationInput)
  const evaluation = shieldMeasuredEvaluation.safeParse(input.evaluation)
  const groundTruth = shieldGroundTruthDataset.safeParse(groundTruthInput)
  if (!capture.success || !validation.success || !evaluation.success || !groundTruth.success) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield evidence does not match its closed schemas")
  }
  if (
    keccak256(stringToHex(input.captureText)) !== evaluation.data.preservedEvidence.captureContentHash ||
    keccak256(stringToHex(input.validationText)) !== evaluation.data.preservedEvidence.manualValidationContentHash ||
    keccak256(stringToHex(input.groundTruthText)) !== evaluation.data.preservedEvidence.groundTruthContentHash
  ) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield source evidence hash changed")
  }
  if (
    JSON.stringify(capture.data.analyzer) !== JSON.stringify(validation.data.analyzer) ||
    JSON.stringify(capture.data.compiler) !== JSON.stringify(validation.data.compiler) ||
    JSON.stringify(evaluation.data.tooling.analyzer) !== JSON.stringify(validation.data.analyzer) ||
    JSON.stringify(evaluation.data.tooling.compiler) !== JSON.stringify(validation.data.compiler)
  ) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published analyzer or compiler identity drifted")
  }

  const rawOutputs = new Map<string, unknown>()
  for (const output of capture.data.outputs) {
    const rawText = input.rawOutputTexts.get(output.path)
    if (rawText === undefined || keccak256(stringToHex(rawText)) !== output.contentHash) {
      throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", `raw output hash changed for ${output.fixtureId}`)
    }
    let rawInput: unknown
    try {
      rawInput = JSON.parse(rawText) as unknown
    } catch {
      throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", `raw output is not JSON for ${output.fixtureId}`)
    }
    const raw = shieldSlitherOutput.safeParse(rawInput)
    if (!raw.success || raw.data.results.detectors.length !== output.detectorCount) {
      throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", `raw detector count changed for ${output.fixtureId}`)
    }
    rawOutputs.set(output.path, rawInput)
  }
  const capturedFixtures = capture.data.outputs.map((output) => ({ fixtureId: output.fixtureId, path: output.path })).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
  const validatedFixtures = validation.data.fixtures.map((fixture) => ({ fixtureId: fixture.fixtureId, path: fixture.rawOutputPath })).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
  if (JSON.stringify(capturedFixtures) !== JSON.stringify(validatedFixtures)) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "capture and manual-validation fixture sets differ")
  }

  let runsInput: unknown
  try {
    runsInput = JSON.parse(input.runsText) as unknown
  } catch {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield runs are not JSON")
  }
  const runs = shieldEvaluationRuns.safeParse(runsInput)
  if (!runs.success || keccak256(stringToHex(input.runsText)) !== evaluation.data.preservedEvidence.runsContentHash) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield runs or their content hash changed")
  }
  const rebuiltRuns = buildValidatedShieldRuns(validation.data, rawOutputs)
  if (JSON.stringify(rebuiltRuns) !== JSON.stringify(runs.data)) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield runs do not match raw outputs and manual validation")
  }

  const signals = validation.data.fixtures.flatMap((fixture) => fixture.signals)
  const counts = {
    total: signals.length,
    confirmed: signals.filter((signal) => signal.decision === "confirmed").length,
    rejected: signals.filter((signal) => signal.decision === "rejected").length,
    outOfScope: signals.filter((signal) => signal.decision === "out_of_scope").length,
  }
  const report = evaluateShieldDataset(groundTruth.data, runs.data)
  if (
    evaluation.data.datasetId !== validation.data.datasetId ||
    evaluation.data.datasetId !== groundTruth.data.datasetId ||
    evaluation.data.relationship !== validation.data.assessorRelationship ||
    JSON.stringify(evaluation.data.rawSignalCounts) !== JSON.stringify(counts) ||
    JSON.stringify(evaluation.data.report) !== JSON.stringify(report)
  ) {
    throw new ShieldMeasurementError("PUBLISHED_EVIDENCE_MISMATCH", "published Shield evaluation does not reproduce")
  }
  return report
}

export function buildValidatedShieldRuns(
  validationInput: unknown,
  rawOutputs: ReadonlyMap<string, unknown>,
): ShieldEvaluationRuns {
  const parsed = shieldManualValidation.safeParse(validationInput)
  if (!parsed.success) throw new ShieldMeasurementError("INVALID_VALIDATION", "manual validation does not match the closed schema")
  const validation = parsed.data
  const fixtureIds = validation.fixtures.map((item) => item.fixtureId)
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    throw new ShieldMeasurementError("INVALID_VALIDATION", "fixture IDs must be unique")
  }

  const runs = validation.fixtures.map((fixture) => {
    const rawInput = rawOutputs.get(fixture.rawOutputPath)
    if (rawInput === undefined) throw new ShieldMeasurementError("RAW_OUTPUT_MISSING", `missing ${fixture.rawOutputPath}`)
    const raw = shieldSlitherOutput.safeParse(rawInput)
    if (!raw.success) throw new ShieldMeasurementError("RAW_OUTPUT_MISMATCH", `invalid ${fixture.rawOutputPath}`)
    if (raw.data.results.detectors.length !== fixture.signals.length) {
      throw new ShieldMeasurementError("VALIDATION_MISMATCH", `signal count changed for ${fixture.fixtureId}`)
    }
    const byIndex = new Map(fixture.signals.map((signal) => [signal.signalIndex, signal]))
    if (byIndex.size !== fixture.signals.length) {
      throw new ShieldMeasurementError("INVALID_VALIDATION", `signal indexes must be unique for ${fixture.fixtureId}`)
    }
    raw.data.results.detectors.forEach((detector, index) => validateSignal(fixture.fixtureId, index, detector, byIndex.get(index)))

    const findings = fixture.signals.filter((signal) => signal.decision === "confirmed").map((signal) => {
      if (signal.finding.affectedAddress !== fixture.targetAddress || signal.finding.evidence.some((item) => item.contentHash !== fixture.sourceBundleHash)) {
        throw new ShieldMeasurementError("VALIDATION_MISMATCH", `confirmed evidence is not bound to ${fixture.fixtureId}`)
      }
      return signal.finding
    })
    const negativeControls = fixture.signals
      .filter((signal) => signal.decision === "rejected")
      .map((signal) => ({ ruleId: signal.mappedRuleId, reason: signal.rationale }))
    const artifact = {
      schemaVersion: "knot.shield.artifact/1" as const,
      category: "security" as const,
      capability: "analysis" as const,
      taskId: `shield-corpus-v1/${fixture.fixtureId}`,
      status: fixture.unresolved.length === 0 ? "ASSESSED" as const : "PARTIAL" as const,
      reasonCode: fixture.unresolved.length === 0 ? null : "UNRESOLVED_CHECKS",
      assessedAtUtc: fixture.assessedAtUtc,
      target: { chainId: 56 as const, address: fixture.targetAddress },
      snapshot: { blockNumber: null, blockHash: null, sourceBundleHash: fixture.sourceBundleHash },
      proxy: { standard: "ERC-1967" as const, implementation: null, admin: null, beacon: null },
      findings,
      negativeControls,
      unresolved: fixture.unresolved,
      limitations: fixture.limitations,
    }
    return { fixtureId: fixture.fixtureId, artifactHash: hashShieldArtifact(artifact), artifact }
  })

  return shieldEvaluationRuns.parse({ schemaVersion: "knot.shield.runs/1", datasetId: validation.datasetId, runs })
}

function validateSignal(
  fixtureId: string,
  index: number,
  detector: z.infer<typeof rawDetector>,
  signal: z.infer<typeof reviewedSignal> | undefined,
): void {
  if (!signal) throw new ShieldMeasurementError("VALIDATION_MISMATCH", `signal ${index} is unreviewed for ${fixtureId}`)
  const mapping = detector.elements[0]!.source_mapping
  if (
    signal.detectorCheck !== detector.check ||
    signal.detectorImpact !== detector.impact ||
    signal.detectorConfidence !== detector.confidence ||
    signal.sourcePath !== mapping.filename_relative ||
    JSON.stringify(signal.sourceLines) !== JSON.stringify(mapping.lines)
  ) {
    throw new ShieldMeasurementError("VALIDATION_MISMATCH", `signal ${index} changed for ${fixtureId}`)
  }
}
