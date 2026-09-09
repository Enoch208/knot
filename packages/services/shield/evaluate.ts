import { keccak256, stringToHex } from "viem"
import { z } from "zod"
import { address, hexDigest } from "../../contracts/src/primitives.ts"
import { shieldArtifact, shieldRuleId, type ShieldArtifact } from "./schemas.ts"

const findingCategory = z.enum(["VULNERABILITY", "PRIVILEGED_CAPABILITY", "CONFIGURATION_RISK"])
const severity = z.enum(["critical", "high", "medium", "low", "informational"])
const location = z.string().regex(/^.+:[1-9][0-9]*(-[1-9][0-9]*)?$/)
const sourcePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/)

const sourceFile = z
  .object({
    path: sourcePath,
    contentHash: hexDigest,
  })
  .strict()

const expectedFinding = z
  .object({
    truthId: z.string().min(1),
    ruleId: shieldRuleId,
    category: findingCategory,
    affectedAddress: address,
    sourceLocation: location.nullable(),
    requiredPreconditions: z.array(z.string().min(1)).min(1),
    allowedSeverities: z.array(severity).min(1),
    criticalCase: z.boolean(),
  })
  .strict()

const negativeControl = z
  .object({
    ruleId: shieldRuleId,
    category: findingCategory,
    affectedAddress: address,
    sourceLocation: location.nullable(),
    reason: z.string().min(1),
  })
  .strict()

const fixture = z
  .object({
    fixtureId: z.string().min(1),
    role: z.enum(["development", "holdout"]),
    createdAtUtc: z.iso.datetime(),
    relationship: z.enum(["team-owned", "external-permissive"]),
    sourceBundleHash: hexDigest,
    sourceFiles: z.array(sourceFile).min(1),
    sourceLicense: z.string().min(1),
    targetAddress: address,
    expectedFindings: z.array(expectedFinding),
    negativeControls: z.array(negativeControl),
  })
  .strict()
  .superRefine((value, context) => {
    const truthIds = value.expectedFindings.map((item) => item.truthId)
    if (new Set(truthIds).size !== truthIds.length) {
      context.addIssue({ code: "custom", path: ["expectedFindings"], message: "truth IDs must be unique within a fixture" })
    }
    const sourcePaths = value.sourceFiles.map((item) => item.path)
    if (new Set(sourcePaths).size !== sourcePaths.length) {
      context.addIssue({ code: "custom", path: ["sourceFiles"], message: "source paths must be unique within a fixture" })
    }
    if (sourcePaths.some((path, index) => index > 0 && path < sourcePaths[index - 1]!)) {
      context.addIssue({ code: "custom", path: ["sourceFiles"], message: "source paths must be sorted" })
    }
    for (const finding of value.expectedFindings) {
      if (new Set(finding.allowedSeverities).size !== finding.allowedSeverities.length) {
        context.addIssue({ code: "custom", path: ["expectedFindings", finding.truthId, "allowedSeverities"], message: "allowed severities must be unique" })
      }
    }
  })

export const shieldGroundTruthDataset = z
  .object({
    schemaVersion: z.literal("knot.shield.ground-truth/1"),
    datasetId: z.string().min(1),
    rulesFrozenAtUtc: z.iso.datetime(),
    groundTruthFrozenAtUtc: z.iso.datetime(),
    compiler: z
      .object({
        name: z.literal("solc"),
        version: z.string().regex(/^0\.[0-9]+\.[0-9]+$/),
        optimizerEnabled: z.boolean(),
        optimizerRuns: z.number().int().positive(),
        evmVersion: z.string().min(1),
        bytecodeHash: z.literal("none"),
      })
      .strict(),
    sourceHashPolicy: z
      .object({
        algorithm: z.literal("keccak256"),
        contentEncoding: z.literal("utf8"),
        bundleEncoding: z.literal("JSON.stringify(sourceFiles)"),
        ordering: z.literal("path-ascending"),
      })
      .strict(),
    rules: z
      .object({
        path: sourcePath,
        contentHash: hexDigest,
      })
      .strict(),
    adjudication: z
      .object({
        policyVersion: z.string().min(1),
        assessorRelationship: z.string().min(1),
        matchingRule: z.literal("rule+category+address+location+preconditions"),
      })
      .strict(),
    fixtures: z.array(fixture).min(6),
  })
  .strict()
  .superRefine((value, context) => {
    const fixtureIds = value.fixtures.map((item) => item.fixtureId)
    if (new Set(fixtureIds).size !== fixtureIds.length) {
      context.addIssue({ code: "custom", path: ["fixtures"], message: "fixture IDs must be unique" })
    }
    if (value.fixtures.every((item) => item.role !== "holdout")) {
      context.addIssue({ code: "custom", path: ["fixtures"], message: "at least one frozen holdout fixture is required" })
    }
    const ruleFreeze = Date.parse(value.rulesFrozenAtUtc)
    if (value.fixtures.some((item) => item.role === "development" && Date.parse(item.createdAtUtc) > ruleFreeze)) {
      context.addIssue({ code: "custom", path: ["fixtures"], message: "development fixtures must predate or match the rule freeze" })
    }
    if (value.fixtures.some((item) => item.role === "holdout" && Date.parse(item.createdAtUtc) <= ruleFreeze)) {
      context.addIssue({ code: "custom", path: ["fixtures"], message: "holdout fixtures must postdate the rule freeze" })
    }
    if (Date.parse(value.groundTruthFrozenAtUtc) < Date.parse(value.rulesFrozenAtUtc)) {
      context.addIssue({ code: "custom", path: ["groundTruthFrozenAtUtc"], message: "ground truth cannot predate the rule freeze" })
    }
    if (value.fixtures.some((item) => Date.parse(item.createdAtUtc) > Date.parse(value.groundTruthFrozenAtUtc))) {
      context.addIssue({ code: "custom", path: ["groundTruthFrozenAtUtc"], message: "ground truth cannot predate a fixture" })
    }
  })

export const shieldEvaluationRuns = z
  .object({
    schemaVersion: z.literal("knot.shield.runs/1"),
    datasetId: z.string().min(1),
    runs: z.array(
      z
        .object({
          fixtureId: z.string().min(1),
          artifactHash: hexDigest,
          artifact: shieldArtifact,
        })
        .strict(),
    ),
  })
  .strict()

const countSet = z
  .object({
    truePositives: z.number().int().nonnegative(),
    falsePositives: z.number().int().nonnegative(),
    falseNegatives: z.number().int().nonnegative(),
    criticalCaseMisses: z.number().int().nonnegative(),
    severityValid: z.number().int().nonnegative(),
    severityInvalid: z.number().int().nonnegative(),
    negativeControlViolations: z.number().int().nonnegative(),
  })
  .strict()

const ratio = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    decimal: z.string().regex(/^(0|1|0\.[0-9]{6}|1\.000000)$/).nullable(),
  })
  .strict()

export const shieldEvaluationReport = z
  .object({
    schemaVersion: z.literal("knot.shield.evaluation/1"),
    datasetId: z.string().min(1),
    datasetHash: hexDigest,
    completedFixtureCount: z.number().int().min(6),
    holdoutFixtureCount: z.number().int().min(1),
    counts: countSet,
    precision: ratio,
    recall: ratio,
    severityValidity: ratio,
    fixtures: z.array(
      z
        .object({
          fixtureId: z.string(),
          role: z.enum(["development", "holdout"]),
          counts: countSet,
          matchedTruthIds: z.array(z.string()),
          missedTruthIds: z.array(z.string()),
          unsupportedFindingIndexes: z.array(z.number().int().nonnegative()),
          negativeControlFindingIndexes: z.array(z.number().int().nonnegative()),
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()

export type ShieldGroundTruthDataset = z.infer<typeof shieldGroundTruthDataset>
export type ShieldEvaluationRuns = z.infer<typeof shieldEvaluationRuns>
export type ShieldEvaluationReport = z.infer<typeof shieldEvaluationReport>

export class ShieldEvaluationError extends Error {
  readonly code: "INVALID_DATASET" | "INVALID_RUNS" | "INCOMPLETE_RUNS" | "EVIDENCE_MISMATCH"

  constructor(code: ShieldEvaluationError["code"], message: string) {
    super(message)
    this.name = "ShieldEvaluationError"
    this.code = code
  }
}

export function hashShieldArtifact(artifact: ShieldArtifact): `0x${string}` {
  return keccak256(stringToHex(JSON.stringify(shieldArtifact.parse(artifact))))
}

export function evaluateShieldDataset(datasetInput: unknown, runsInput: unknown): ShieldEvaluationReport {
  const parsedDataset = shieldGroundTruthDataset.safeParse(datasetInput)
  if (!parsedDataset.success) throw new ShieldEvaluationError("INVALID_DATASET", "Shield ground truth does not match the closed schema")
  const parsedRuns = shieldEvaluationRuns.safeParse(runsInput)
  if (!parsedRuns.success) throw new ShieldEvaluationError("INVALID_RUNS", "Shield runs do not match the closed schema")
  const dataset = parsedDataset.data
  const runs = parsedRuns.data
  if (runs.datasetId !== dataset.datasetId) throw new ShieldEvaluationError("EVIDENCE_MISMATCH", "run dataset ID does not match ground truth")
  const byFixture = new Map<string, ShieldEvaluationRuns["runs"][number]>()
  for (const run of runs.runs) {
    if (byFixture.has(run.fixtureId)) throw new ShieldEvaluationError("INVALID_RUNS", "duplicate fixture run")
    byFixture.set(run.fixtureId, run)
  }
  if (byFixture.size !== dataset.fixtures.length || dataset.fixtures.some((item) => !byFixture.has(item.fixtureId))) {
    throw new ShieldEvaluationError("INCOMPLETE_RUNS", "every frozen fixture must have exactly one run")
  }
  if (runs.runs.some((run) => !dataset.fixtures.some((item) => item.fixtureId === run.fixtureId))) {
    throw new ShieldEvaluationError("INVALID_RUNS", "runs contain an unknown fixture")
  }

  const fixtureReports = dataset.fixtures.map((item) => {
    const run = byFixture.get(item.fixtureId)
    if (!run) throw new ShieldEvaluationError("INCOMPLETE_RUNS", "fixture run is missing")
    if (hashShieldArtifact(run.artifact) !== run.artifactHash) {
      throw new ShieldEvaluationError("EVIDENCE_MISMATCH", "artifact content hash does not match the preserved run")
    }
    if (run.artifact.status !== "ASSESSED" && run.artifact.status !== "PARTIAL") {
      throw new ShieldEvaluationError("EVIDENCE_MISMATCH", "a refused or invalid artifact cannot be scored")
    }
    if (run.artifact.target.address !== item.targetAddress || run.artifact.snapshot.sourceBundleHash !== item.sourceBundleHash) {
      throw new ShieldEvaluationError("EVIDENCE_MISMATCH", "artifact target or source hash does not match its frozen fixture")
    }
    return evaluateFixture(item, run.artifact)
  })
  const counts = fixtureReports.reduce((total, item) => addCounts(total, item.counts), emptyCounts())
  return shieldEvaluationReport.parse({
    schemaVersion: "knot.shield.evaluation/1",
    datasetId: dataset.datasetId,
    datasetHash: keccak256(stringToHex(JSON.stringify(dataset))),
    completedFixtureCount: fixtureReports.length,
    holdoutFixtureCount: dataset.fixtures.filter((item) => item.role === "holdout").length,
    counts,
    precision: asRatio(counts.truePositives, counts.truePositives + counts.falsePositives),
    recall: asRatio(counts.truePositives, counts.truePositives + counts.falseNegatives),
    severityValidity: asRatio(counts.severityValid, counts.severityValid + counts.severityInvalid),
    fixtures: fixtureReports,
    limitations: [
      "results apply only to the frozen fixtures and exact source hashes",
      "precision and recall on this set do not establish comprehensive audit coverage",
      "a holdout fixture count is disclosed but is not statistical evidence of generalization",
    ],
  })
}

function evaluateFixture(
  fixtureInput: ShieldGroundTruthDataset["fixtures"][number],
  artifact: ShieldArtifact,
): ShieldEvaluationReport["fixtures"][number] {
  const matchedTruthIds: string[] = []
  const missedTruthIds: string[] = []
  const unsupportedFindingIndexes: number[] = []
  const negativeControlFindingIndexes: number[] = []
  const matchedActual = new Set<number>()
  let severityValid = 0
  let severityInvalid = 0
  let criticalCaseMisses = 0

  for (const truth of fixtureInput.expectedFindings) {
    const index = artifact.findings.findIndex((finding, candidate) => !matchedActual.has(candidate) && matchesTruth(finding, truth))
    if (index === -1) {
      missedTruthIds.push(truth.truthId)
      if (truth.criticalCase) criticalCaseMisses += 1
      continue
    }
    matchedActual.add(index)
    matchedTruthIds.push(truth.truthId)
    if (truth.allowedSeverities.includes(artifact.findings[index]!.severity)) severityValid += 1
    else severityInvalid += 1
  }

  for (const [index, finding] of artifact.findings.entries()) {
    if (matchedActual.has(index)) continue
    unsupportedFindingIndexes.push(index)
    if (fixtureInput.negativeControls.some((control) => matchesControl(finding, control))) {
      negativeControlFindingIndexes.push(index)
    }
  }

  const counts = {
    truePositives: matchedTruthIds.length,
    falsePositives: unsupportedFindingIndexes.length,
    falseNegatives: missedTruthIds.length,
    criticalCaseMisses,
    severityValid,
    severityInvalid,
    negativeControlViolations: negativeControlFindingIndexes.length,
  }
  return {
    fixtureId: fixtureInput.fixtureId,
    role: fixtureInput.role,
    counts,
    matchedTruthIds,
    missedTruthIds,
    unsupportedFindingIndexes,
    negativeControlFindingIndexes,
  }
}

function matchesTruth(
  finding: ShieldArtifact["findings"][number],
  truth: ShieldGroundTruthDataset["fixtures"][number]["expectedFindings"][number],
): boolean {
  return finding.ruleId === truth.ruleId &&
    finding.category === truth.category &&
    finding.affectedAddress === truth.affectedAddress &&
    finding.sourceLocation === truth.sourceLocation &&
    truth.requiredPreconditions.every((precondition) => finding.preconditions.includes(precondition))
}

function matchesControl(
  finding: ShieldArtifact["findings"][number],
  control: ShieldGroundTruthDataset["fixtures"][number]["negativeControls"][number],
): boolean {
  return finding.ruleId === control.ruleId &&
    finding.category === control.category &&
    finding.affectedAddress === control.affectedAddress &&
    finding.sourceLocation === control.sourceLocation
}

function emptyCounts(): ShieldEvaluationReport["counts"] {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    criticalCaseMisses: 0,
    severityValid: 0,
    severityInvalid: 0,
    negativeControlViolations: 0,
  }
}

function addCounts(left: ShieldEvaluationReport["counts"], right: ShieldEvaluationReport["counts"]): ShieldEvaluationReport["counts"] {
  return {
    truePositives: left.truePositives + right.truePositives,
    falsePositives: left.falsePositives + right.falsePositives,
    falseNegatives: left.falseNegatives + right.falseNegatives,
    criticalCaseMisses: left.criticalCaseMisses + right.criticalCaseMisses,
    severityValid: left.severityValid + right.severityValid,
    severityInvalid: left.severityInvalid + right.severityInvalid,
    negativeControlViolations: left.negativeControlViolations + right.negativeControlViolations,
  }
}

function asRatio(numerator: number, denominator: number): ShieldEvaluationReport["precision"] {
  return {
    numerator,
    denominator,
    decimal: denominator === 0 ? null : (numerator / denominator).toFixed(6),
  }
}
