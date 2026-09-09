import { z } from "zod"
import { agentKey, baseUnits, chainId, evidenceClass, hexDigest } from "../../contracts/src/primitives.ts"
import { taskSpec } from "../../contracts/src/task.ts"

export const evidenceReference = z
  .object({
    uri: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().positive(),
    mediaType: z.string().min(1),
    observedAtUtc: z.iso.datetime(),
    evidenceClass,
  })
  .strict()

export const inputIdentity = z
  .object({
    taskId: z.string().min(1),
    taskInputHash: hexDigest,
    snapshotId: z.string().min(1).nullable(),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export const observedDuration = z
  .object({
    startedAtUtc: z.iso.datetime(),
    endedAtUtc: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.endedAtUtc) - Date.parse(value.startedAtUtc) === value.durationMs,
    { message: "durationMs must equal the observed start/end interval" },
  )

export const observedCost = z
  .object({
    kind: z.enum(["service_fee", "network_fee", "compute", "data"]),
    amount: z
      .object({
        units: baseUnits,
        decimals: z.number().int().min(0).max(36),
        symbol: z.string().min(1).max(32),
        chainId: chainId.nullable(),
        token: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
      })
      .strict(),
    provenance: evidenceReference,
  })
  .strict()

export const costEvidencePayload = z
  .object({
    schemaVersion: z.literal("knot.advantage.cost-evidence/1"),
    kind: z.enum(["service_fee", "network_fee", "compute", "data"]),
    units: baseUnits,
    decimals: z.number().int().min(0).max(36),
    symbol: z.string().min(1).max(32),
    chainId: chainId.nullable(),
    token: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
    observedAtUtc: z.iso.datetime(),
    method: z.enum(["transaction_receipt", "provider_meter", "invoice", "measured_wall_clock"]),
    sourceRecordId: z.string().min(1),
  })
  .strict()

const pathShape = {
  inputIdentity,
  observation: observedDuration,
  costs: z.array(observedCost).min(1),
  rawOutput: evidenceReference,
  artifact: evidenceReference,
} as const

export const agentExperimentPath = z
  .object({
    kind: z.literal("agent"),
    agent: agentKey,
    operatorRelationship: z.enum(["independent", "same_operator_reference"]),
    methodId: z.string().min(1),
    methodVersion: z.string().min(1),
    ...pathShape,
  })
  .strict()

export const baselineExperimentPath = z
  .object({
    kind: z.literal("non_agent_baseline"),
    methodId: z.string().min(1),
    methodVersion: z.string().min(1),
    implementation: evidenceReference,
    usesSameInput: z.literal(true),
    usesAgentOutput: z.literal(false),
    ...pathShape,
  })
  .strict()

export const evaluatorIdentity = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
  })
  .strict()

export const pairedExperimentInput = z
  .object({
    schemaVersion: z.literal("knot.advantage.run-input/1"),
    experimentId: z.string().min(1),
    evidenceClass,
    task: evidenceReference,
    input: evidenceReference,
    agentPath: agentExperimentPath,
    baselinePath: baselineExperimentPath,
    evaluator: evaluatorIdentity,
  })
  .strict()

export const rawDimensionScore = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    toleranceBps: z.number().int().min(0).max(10_000),
    agent: z.object({ scoreBps: z.number().int().min(0).max(10_000), rationale: z.string().min(1) }).strict(),
    baseline: z.object({ scoreBps: z.number().int().min(0).max(10_000), rationale: z.string().min(1) }).strict(),
  })
  .strict()

export const qualityDimension = rawDimensionScore
  .extend({ result: z.enum(["agent_win", "baseline_win", "tie"]) })
  .strict()

export const experimentEvaluation = z
  .object({
    evaluator: evaluatorIdentity,
    decisionRule: z.literal("lexicographic"),
    dimensions: z.array(qualityDimension).min(1),
  })
  .strict()
  .refine((value) => new Set(value.dimensions.map((dimension) => dimension.id)).size === value.dimensions.length, {
    message: "quality dimension IDs must be unique",
  })

export const comparisonSummary = z
  .object({
    winner: z.enum(["agent", "baseline", "tie"]),
    agentWins: z.number().int().nonnegative(),
    baselineWins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    decisiveDimensionId: z.string().min(1).nullable(),
  })
  .strict()

export const pairedExperimentRecord = z
  .object({
    schemaVersion: z.literal("knot.advantage.experiment/1"),
    experimentId: z.string().min(1),
    evidenceClass,
    task: z.object({ spec: taskSpec, reference: evidenceReference }).strict(),
    input: evidenceReference,
    agentPath: agentExperimentPath,
    baselinePath: baselineExperimentPath,
    evaluation: experimentEvaluation,
    comparison: comparisonSummary,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedIdentity = {
      taskId: value.task.spec.taskId,
      taskInputHash: value.task.spec.inputHash,
      snapshotId: value.task.spec.snapshotId,
      inputSha256: value.input.sha256,
    }
    for (const [pathName, identity] of [
      ["agentPath", value.agentPath.inputIdentity],
      ["baselinePath", value.baselinePath.inputIdentity],
    ] as const) {
      if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) {
        context.addIssue({ code: "custom", path: [pathName, "inputIdentity"], message: "path input identity does not match the experiment input" })
      }
    }
    const expected = deriveComparison(value.evaluation.dimensions)
    if (JSON.stringify(expected) !== JSON.stringify(value.comparison)) {
      context.addIssue({ code: "custom", path: ["comparison"], message: "comparison must be derived from evaluator scores" })
    }
    for (const [index, dimension] of value.evaluation.dimensions.entries()) {
      const result = compareDimension(dimension.agent.scoreBps, dimension.baseline.scoreBps, dimension.toleranceBps)
      if (dimension.result !== result) {
        context.addIssue({ code: "custom", path: ["evaluation", "dimensions", index, "result"], message: "dimension result must be derived from scores" })
      }
    }
  })

export const experimentDataset = z
  .object({
    schemaVersion: z.literal("knot.advantage.dataset/1"),
    generatedAtUtc: z.iso.datetime(),
    experiments: z.array(pairedExperimentRecord).min(1),
  })
  .strict()

export function compareDimension(agent: number, baseline: number, tolerance: number): "agent_win" | "baseline_win" | "tie" {
  if (Math.abs(agent - baseline) <= tolerance) return "tie"
  return agent > baseline ? "agent_win" : "baseline_win"
}

export function deriveComparison(dimensions: ReadonlyArray<z.infer<typeof qualityDimension>>): z.infer<typeof comparisonSummary> {
  const results = dimensions.map((dimension) => compareDimension(dimension.agent.scoreBps, dimension.baseline.scoreBps, dimension.toleranceBps))
  const decisiveIndex = results.findIndex((result) => result !== "tie")
  const decisive = decisiveIndex < 0 ? null : dimensions[decisiveIndex] ?? null
  const decisiveResult = decisiveIndex < 0 ? "tie" : results[decisiveIndex]
  return {
    winner: decisiveResult === "agent_win" ? "agent" : decisiveResult === "baseline_win" ? "baseline" : "tie",
    agentWins: results.filter((result) => result === "agent_win").length,
    baselineWins: results.filter((result) => result === "baseline_win").length,
    ties: results.filter((result) => result === "tie").length,
    decisiveDimensionId: decisive?.id ?? null,
  }
}

export type EvidenceReference = z.infer<typeof evidenceReference>
export type PairedExperimentInput = z.infer<typeof pairedExperimentInput>
export type PairedExperimentRecord = z.infer<typeof pairedExperimentRecord>
export type ExperimentDataset = z.infer<typeof experimentDataset>
export type RawDimensionScore = z.infer<typeof rawDimensionScore>
