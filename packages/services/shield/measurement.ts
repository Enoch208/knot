import { z } from "zod"
import { address, hexDigest } from "../../contracts/src/primitives.ts"
import {
  hashShieldArtifact,
  shieldEvaluationRuns,
  type ShieldEvaluationRuns,
} from "./evaluate.ts"
import { shieldFinding, shieldRuleId } from "./schemas.ts"

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
    analyzer: z
      .object({
        name: z.literal("slither"),
        version: z.literal("0.11.3"),
        detectorCount: z.literal(100),
      })
      .strict(),
    compiler: z
      .object({
        name: z.literal("solc"),
        version: z.literal("0.8.28"),
        optimizerEnabled: z.literal(true),
        optimizerRuns: z.literal(200),
        evmVersion: z.literal("paris"),
      })
      .strict(),
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

export type ShieldManualValidation = z.infer<typeof shieldManualValidation>

export class ShieldMeasurementError extends Error {
  readonly code: "INVALID_VALIDATION" | "RAW_OUTPUT_MISSING" | "RAW_OUTPUT_MISMATCH" | "VALIDATION_MISMATCH"

  constructor(code: ShieldMeasurementError["code"], message: string) {
    super(message)
    this.name = "ShieldMeasurementError"
    this.code = code
  }
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
