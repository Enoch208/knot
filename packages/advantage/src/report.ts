import type { z } from "zod"
import { keccak256, toHex } from "viem"
import type { ExperimentDataset, PairedExperimentRecord } from "./schemas.ts"
import { validateExperimentDataset, type EvidenceResolver } from "./runner.ts"
import { GridQuantIndependentEvaluator } from "./gridquant.ts"
import { HealthGuardIndependentEvaluator } from "./healthguard.ts"
import { RangePilotIndependentEvaluator } from "./rangepilot.ts"
import { YieldScoutIndependentEvaluator } from "./yieldscout.ts"
import {
  shieldMeasuredEvaluation,
  shieldSlitherCapture,
  verifyPublishedShieldMeasurement,
  type ShieldEvaluationReport,
} from "../../services/shield/index.ts"
import { renderAgentAdvantageReport } from "./report-markdown.ts"

const categories = ["health", "rebalancing", "grid", "yield"] as const
type FinanceCategory = (typeof categories)[number]

export interface AdvantageDatasetSource {
  repositoryPath: string
  dataset: unknown
  resolveEvidence: EvidenceResolver
  lifecycleEvidence: {
    start: LifecycleEvidenceValue
    end: LifecycleEvidenceValue
  }
}

export interface LifecycleEvidenceValue {
  repositoryPath: string
  document: unknown
  valuePath: readonly (string | number)[]
}

export interface ShieldReportSource {
  evaluationPath: string
  captureText: string
  validationText: string
  rawOutputTexts: ReadonlyMap<string, string>
  runsText: string
  evaluation: unknown
  groundTruthText: string
}

export interface VerifiedReportExperiment {
  category: FinanceCategory
  repositoryPath: string
  record: PairedExperimentRecord
  inputBinding: {
    taskInputHash: string
    rawInputKeccak256: string
    exact: boolean
  }
  lifecycleEvidencePaths: readonly string[]
}

export interface VerifiedShieldReport {
  evaluationPath: string
  evaluation: z.infer<typeof shieldMeasuredEvaluation>
  capture: z.infer<typeof shieldSlitherCapture>
  report: ShieldEvaluationReport
}

export class AdvantageReportError extends Error {
  readonly code: "DATASET_SHAPE" | "DUPLICATE_CATEGORY" | "LIFECYCLE_EVIDENCE" | "MISSING_CATEGORY" | "UNEXPECTED_CATEGORY"

  constructor(code: AdvantageReportError["code"], message: string) {
    super(message)
    this.name = "AdvantageReportError"
    this.code = code
  }
}

export async function buildAgentAdvantageReport(
  sources: readonly AdvantageDatasetSource[],
  shieldSource: ShieldReportSource,
): Promise<string> {
  const experiments: VerifiedReportExperiment[] = []
  const evaluators = [
    new HealthGuardIndependentEvaluator(),
    new RangePilotIndependentEvaluator(),
    new GridQuantIndependentEvaluator(),
    new YieldScoutIndependentEvaluator(),
  ]
  for (const source of sources) {
    const dataset: ExperimentDataset = await validateExperimentDataset(source.dataset, source.resolveEvidence, evaluators)
    if (dataset.experiments.length !== 1) {
      throw new AdvantageReportError("DATASET_SHAPE", `${source.repositoryPath} must contain exactly one experiment`)
    }
    const record = dataset.experiments[0]
    if (!record) throw new AdvantageReportError("DATASET_SHAPE", `${source.repositoryPath} has no experiment`)
    const category = record.task.spec.category
    if (!isFinanceCategory(category)) {
      throw new AdvantageReportError("UNEXPECTED_CATEGORY", `unexpected finance category: ${category}`)
    }
    if (experiments.some((item) => item.category === category)) {
      throw new AdvantageReportError("DUPLICATE_CATEGORY", `duplicate finance category: ${category}`)
    }
    const lifecycleStart = readEvidenceValue(source.lifecycleEvidence.start)
    const lifecycleEnd = readEvidenceValue(source.lifecycleEvidence.end)
    if (lifecycleStart !== record.agentPath.observation.startedAtUtc || lifecycleEnd !== record.agentPath.observation.endedAtUtc) {
      throw new AdvantageReportError("LIFECYCLE_EVIDENCE", `${source.repositoryPath} lifecycle does not match its retained raw evidence`)
    }
    const rawInputKeccak256 = keccak256(toHex(await source.resolveEvidence(record.input)))
    experiments.push({
      category,
      repositoryPath: source.repositoryPath,
      record,
      inputBinding: {
        taskInputHash: record.task.spec.inputHash,
        rawInputKeccak256,
        exact: record.task.spec.inputHash === rawInputKeccak256,
      },
      lifecycleEvidencePaths: [...new Set([
        source.lifecycleEvidence.start.repositoryPath,
        source.lifecycleEvidence.end.repositoryPath,
      ])],
    })
  }
  const missing = categories.filter((category) => !experiments.some((item) => item.category === category))
  if (missing.length > 0) throw new AdvantageReportError("MISSING_CATEGORY", `missing finance categories: ${missing.join(", ")}`)
  if (experiments.length !== categories.length) {
    throw new AdvantageReportError("DATASET_SHAPE", `expected ${categories.length} finance datasets`)
  }
  experiments.sort((left, right) => categories.indexOf(left.category) - categories.indexOf(right.category))

  const evaluation = shieldMeasuredEvaluation.parse(shieldSource.evaluation)
  const captureInput: unknown = JSON.parse(shieldSource.captureText)
  const capture = shieldSlitherCapture.parse(captureInput)
  const report = verifyPublishedShieldMeasurement({
    captureText: shieldSource.captureText,
    validationText: shieldSource.validationText,
    rawOutputTexts: shieldSource.rawOutputTexts,
    runsText: shieldSource.runsText,
    evaluation,
    groundTruthText: shieldSource.groundTruthText,
  })
  return renderAgentAdvantageReport(experiments, {
    evaluationPath: shieldSource.evaluationPath,
    evaluation,
    capture,
    report,
  })
}

function isFinanceCategory(value: string): value is FinanceCategory {
  return categories.some((category) => category === value)
}

function readEvidenceValue(source: LifecycleEvidenceValue): unknown {
  let current: unknown = source.document
  for (const key of source.valuePath) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[key]
      continue
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
