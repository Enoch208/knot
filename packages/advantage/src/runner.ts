import { createHash } from "node:crypto"
import { taskSpec, type TaskSpec } from "../../contracts/src/task.ts"
import {
  costEvidencePayload,
  deriveComparison,
  experimentDataset,
  pairedExperimentInput,
  pairedExperimentRecord,
  qualityDimension,
  rawDimensionScore,
  type EvidenceReference,
  type ExperimentDataset,
  type PairedExperimentInput,
  type PairedExperimentRecord,
  type RawDimensionScore,
} from "./schemas.ts"

export type EvidenceResolver = (reference: EvidenceReference) => Promise<Uint8Array>

export interface EvaluatorMaterials {
  task: TaskSpec
  input: Uint8Array
  agent: { rawOutput: Uint8Array; artifact: Uint8Array; observation: PairedExperimentInput["agentPath"]["observation"] }
  baseline: { rawOutput: Uint8Array; artifact: Uint8Array; implementation: Uint8Array; observation: PairedExperimentInput["baselinePath"]["observation"] }
}

export interface ExperimentEvaluator {
  readonly id: string
  readonly version: string
  evaluate(materials: EvaluatorMaterials): Promise<RawDimensionScore[]> | RawDimensionScore[]
}

export class AdvantageValidationError extends Error {
  readonly code: "MISSING_EVIDENCE" | "EVIDENCE_MISMATCH" | "INPUT_MISMATCH" | "COST_UNVERIFIABLE" | "EVALUATOR_UNAVAILABLE" | "EVALUATION_MISMATCH"

  constructor(code: AdvantageValidationError["code"], message: string) {
    super(message)
    this.name = "AdvantageValidationError"
    this.code = code
  }
}

export async function runPairedExperiment(
  candidate: unknown,
  resolver: EvidenceResolver,
  evaluators: readonly ExperimentEvaluator[],
): Promise<PairedExperimentRecord> {
  const input = pairedExperimentInput.parse(candidate)
  const evaluator = findEvaluator(input, evaluators)
  const resolved = await resolveInput(input, resolver)
  const parsedTask = parseTask(resolved.task)
  verifyInputIdentity(input, parsedTask)
  await verifyCosts(input, resolved.references)
  const evaluation = await evaluate(evaluator, {
    task: parsedTask,
    input: resolved.input,
    agent: { rawOutput: resolved.agentRaw, artifact: resolved.agentArtifact, observation: input.agentPath.observation },
    baseline: {
      rawOutput: resolved.baselineRaw,
      artifact: resolved.baselineArtifact,
      implementation: resolved.baselineImplementation,
      observation: input.baselinePath.observation,
    },
  })
  return pairedExperimentRecord.parse({
    schemaVersion: "knot.advantage.experiment/1",
    experimentId: input.experimentId,
    evidenceClass: input.evidenceClass,
    task: { spec: parsedTask, reference: input.task },
    input: input.input,
    agentPath: input.agentPath,
    baselinePath: input.baselinePath,
    evaluation,
    comparison: deriveComparison(evaluation.dimensions),
  })
}

export async function validatePairedExperiment(
  candidate: unknown,
  resolver: EvidenceResolver,
  evaluators: readonly ExperimentEvaluator[],
): Promise<PairedExperimentRecord> {
  const record = pairedExperimentRecord.parse(candidate)
  const rerun = await runPairedExperiment(
    {
      schemaVersion: "knot.advantage.run-input/1",
      experimentId: record.experimentId,
      evidenceClass: record.evidenceClass,
      task: record.task.reference,
      input: record.input,
      agentPath: record.agentPath,
      baselinePath: record.baselinePath,
      evaluator: record.evaluation.evaluator,
    },
    resolver,
    evaluators,
  )
  if (canonicalJson(rerun) !== canonicalJson(record)) {
    throw new AdvantageValidationError("EVALUATION_MISMATCH", "stored scores or winner do not match the independent evaluator")
  }
  return record
}

export async function validateExperimentDataset(
  candidate: unknown,
  resolver: EvidenceResolver,
  evaluators: readonly ExperimentEvaluator[],
): Promise<ExperimentDataset> {
  const dataset = experimentDataset.parse(candidate)
  for (const experiment of dataset.experiments) {
    await validatePairedExperiment(experiment, resolver, evaluators)
  }
  return dataset
}

async function evaluate(evaluator: ExperimentEvaluator, materials: EvaluatorMaterials) {
  const scores = await evaluator.evaluate(materials)
  const dimensions = scores.map((score) => {
    const parsed = rawDimensionScore.parse(score)
    return qualityDimension.parse({
      ...parsed,
      result:
        Math.abs(parsed.agent.scoreBps - parsed.baseline.scoreBps) <= parsed.toleranceBps
          ? "tie"
          : parsed.agent.scoreBps > parsed.baseline.scoreBps
            ? "agent_win"
            : "baseline_win",
    })
  })
  if (dimensions.length === 0 || new Set(dimensions.map((dimension) => dimension.id)).size !== dimensions.length) {
    throw new AdvantageValidationError("EVALUATION_MISMATCH", "evaluator must return unique quality dimensions")
  }
  return { evaluator: { id: evaluator.id, version: evaluator.version }, decisionRule: "lexicographic" as const, dimensions }
}

function findEvaluator(input: PairedExperimentInput, evaluators: readonly ExperimentEvaluator[]): ExperimentEvaluator {
  const evaluator = evaluators.find((item) => item.id === input.evaluator.id && item.version === input.evaluator.version)
  if (!evaluator) throw new AdvantageValidationError("EVALUATOR_UNAVAILABLE", `evaluator ${input.evaluator.id}@${input.evaluator.version} is unavailable`)
  return evaluator
}

async function resolveInput(input: PairedExperimentInput, resolver: EvidenceResolver) {
  verifyEvidenceClasses(input)
  const references = allReferences(input)
  const resolved = new Map<string, Uint8Array>()
  await Promise.all(
    references.map(async ({ label, reference }) => {
      const key = referenceKey(reference)
      if (resolved.has(key)) return
      let bytes: Uint8Array
      try {
        bytes = await resolver(reference)
      } catch {
        throw new AdvantageValidationError("MISSING_EVIDENCE", `${label} evidence is unavailable: ${reference.uri}`)
      }
      if (bytes.byteLength !== reference.byteLength || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
        throw new AdvantageValidationError("EVIDENCE_MISMATCH", `${label} evidence does not match its byte length and SHA-256`)
      }
      resolved.set(key, bytes)
    }),
  )
  const get = (reference: EvidenceReference) => {
    const bytes = resolved.get(referenceKey(reference))
    if (!bytes) throw new AdvantageValidationError("MISSING_EVIDENCE", `evidence was not resolved: ${reference.uri}`)
    return bytes
  }
  return {
    references: resolved,
    task: get(input.task),
    input: get(input.input),
    agentRaw: get(input.agentPath.rawOutput),
    agentArtifact: get(input.agentPath.artifact),
    baselineRaw: get(input.baselinePath.rawOutput),
    baselineArtifact: get(input.baselinePath.artifact),
    baselineImplementation: get(input.baselinePath.implementation),
  }
}

function verifyEvidenceClasses(input: PairedExperimentInput): void {
  if (input.evidenceClass === "publisher_claim") {
    throw new AdvantageValidationError("EVIDENCE_MISMATCH", "a paired experiment cannot be established from a publisher claim")
  }
  const outputs = [
    input.agentPath.rawOutput,
    input.agentPath.artifact,
    input.baselinePath.rawOutput,
    input.baselinePath.artifact,
  ]
  for (const output of outputs) {
    if (output.evidenceClass === "publisher_claim") {
      throw new AdvantageValidationError("EVIDENCE_MISMATCH", "raw experiment outputs cannot be publisher claims")
    }
    if (input.evidenceClass !== "synthetic_fixture" && output.evidenceClass === "synthetic_fixture") {
      throw new AdvantageValidationError("EVIDENCE_MISMATCH", "observed experiments cannot use synthetic raw outputs")
    }
  }
}

function allReferences(input: PairedExperimentInput): Array<{ label: string; reference: EvidenceReference }> {
  const references = [
    { label: "task", reference: input.task },
    { label: "input", reference: input.input },
    { label: "agent raw output", reference: input.agentPath.rawOutput },
    { label: "agent artifact", reference: input.agentPath.artifact },
    { label: "baseline raw output", reference: input.baselinePath.rawOutput },
    { label: "baseline artifact", reference: input.baselinePath.artifact },
    { label: "baseline implementation", reference: input.baselinePath.implementation },
  ]
  for (const cost of input.agentPath.costs) references.push({ label: "agent cost", reference: cost.provenance })
  for (const cost of input.baselinePath.costs) references.push({ label: "baseline cost", reference: cost.provenance })
  return references
}

async function verifyCosts(input: PairedExperimentInput, resolved: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [pathName, costs] of [
    ["agent", input.agentPath.costs],
    ["baseline", input.baselinePath.costs],
  ] as const) {
    for (const cost of costs) {
      if (cost.provenance.evidenceClass === "publisher_claim") {
        throw new AdvantageValidationError("COST_UNVERIFIABLE", `${pathName} cost is only a publisher claim`)
      }
      if (input.evidenceClass !== "synthetic_fixture" && cost.provenance.evidenceClass === "synthetic_fixture") {
        throw new AdvantageValidationError("COST_UNVERIFIABLE", `${pathName} observed cost cannot use synthetic provenance`)
      }
      const bytes = resolved.get(referenceKey(cost.provenance))
      if (!bytes) throw new AdvantageValidationError("COST_UNVERIFIABLE", `${pathName} cost evidence is unavailable`)
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        throw new AdvantageValidationError("COST_UNVERIFIABLE", `${pathName} cost evidence is not valid JSON`)
      }
      const parsed = costEvidencePayload.safeParse(payload)
      const expected = { kind: cost.kind, ...cost.amount }
      if (!parsed.success || parsed.data.kind !== expected.kind || parsed.data.units !== expected.units || parsed.data.decimals !== expected.decimals || parsed.data.symbol !== expected.symbol || parsed.data.chainId !== expected.chainId || parsed.data.token !== expected.token) {
        throw new AdvantageValidationError("COST_UNVERIFIABLE", `${pathName} cost does not match its provenance record`)
      }
    }
  }
}

function parseTask(bytes: Uint8Array): TaskSpec {
  try {
    return taskSpec.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    throw new AdvantageValidationError("INPUT_MISMATCH", "task evidence does not contain a valid closed TaskSpec")
  }
}

function verifyInputIdentity(input: PairedExperimentInput, task: TaskSpec): void {
  const expected = {
    taskId: task.taskId,
    taskInputHash: task.inputHash,
    snapshotId: task.snapshotId,
    inputSha256: input.input.sha256,
  }
  if (canonicalJson(input.agentPath.inputIdentity) !== canonicalJson(expected) || canonicalJson(input.baselinePath.inputIdentity) !== canonicalJson(expected)) {
    throw new AdvantageValidationError("INPUT_MISMATCH", "agent and baseline must observe the exact task and input identity")
  }
}

function referenceKey(reference: EvidenceReference): string {
  return `${reference.uri}\u0000${reference.sha256}`
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}
