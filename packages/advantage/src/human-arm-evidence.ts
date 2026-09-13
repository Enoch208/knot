import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  compareHumanArm,
  type AgentArmObservation,
  type HumanArmComparison,
  type RecordedHumanSession,
} from "./human-arm.ts"

export type HumanArmTaskId = "yield-1188" | "grid-1187" | "range-1189"

export interface FrozenHumanArmTask {
  schemaVersion: "knot.human-arm.task/1"
  taskId: HumanArmTaskId
  category: "yield" | "grid" | "rebalancing"
  inputSha256: string
  answerFields: readonly string[]
  agentPairExperiment: string
}

export interface HumanArmEvidenceInput {
  task: FrozenHumanArmTask | null | undefined
  frozenInputBytes: Uint8Array | null | undefined
  session: RecordedHumanSession | null | undefined
  sessionBytes: Uint8Array | null | undefined
  agent: AgentArmObservation | null | undefined
  agentArtifact: unknown
  agentArtifactBytes: Uint8Array | null | undefined
  sessionPath: string
  recordedAtUtc: string
}

export interface BuiltHumanArmEvidence {
  schemaVersion: "knot.human-arm.comparison/2"
  recordedAtUtc: string
  taskId: HumanArmTaskId
  frozenInputSha256: string
  sessionSha256: string
  agentArtifactSha256: string
  sessionPath: string
  agent: AgentArmObservation
  agentAnswer: Record<string, string>
  humanAnswer: Record<string, string>
  normalizedHumanAnswer: Record<string, string>
  comparison: HumanArmComparison
}

export class HumanArmEvidenceError extends Error {
  readonly code: "MISSING_EVIDENCE" | "TASK_MISMATCH" | "INPUT_HASH_MISMATCH" | "ANSWER_SHAPE" | "ARTIFACT_SHAPE"

  constructor(code: HumanArmEvidenceError["code"], message: string) {
    super(message)
    this.name = "HumanArmEvidenceError"
    this.code = code
  }
}

export function buildHumanArmEvidence(input: HumanArmEvidenceInput): BuiltHumanArmEvidence {
  if (!input.task || !input.frozenInputBytes || !input.session || !input.sessionBytes || !input.agent || !input.agentArtifact || !input.agentArtifactBytes) {
    throw new HumanArmEvidenceError("MISSING_EVIDENCE", "task, frozen input, session bytes, agent observation, and agent artifact bytes are required")
  }
  const task = input.task
  const session = input.session
  const expected = taskContract(task.taskId)
  if (
    task.schemaVersion !== "knot.human-arm.task/1"
    || session.schemaVersion !== "knot.human-arm.session/1"
    || task.category !== expected.category
    || task.agentPairExperiment !== expected.experimentPath
    || task.answerFields.length !== expected.answerFields.length
    || task.answerFields.some((field, index) => field !== expected.answerFields[index])
    || session.taskId !== task.taskId
    || input.agent.category !== expected.category
    || input.agent.experimentPath !== expected.experimentPath
  ) {
    throw new HumanArmEvidenceError("TASK_MISMATCH", `human and agent evidence do not belong to ${task.taskId}`)
  }
  let recordedSession: unknown
  let recordedAgentArtifact: unknown
  try {
    recordedSession = JSON.parse(Buffer.from(input.sessionBytes).toString("utf8")) as unknown
    recordedAgentArtifact = JSON.parse(Buffer.from(input.agentArtifactBytes).toString("utf8")) as unknown
  } catch {
    throw new HumanArmEvidenceError("INPUT_HASH_MISMATCH", `${task.taskId} bound source bytes are not valid JSON`)
  }
  if (!isDeepStrictEqual(recordedSession, session)) {
    throw new HumanArmEvidenceError("INPUT_HASH_MISMATCH", `${task.taskId} session object does not match the recorded bytes`)
  }
  if (!isDeepStrictEqual(recordedAgentArtifact, input.agentArtifact)) {
    throw new HumanArmEvidenceError("INPUT_HASH_MISMATCH", `${task.taskId} agent artifact does not match the recorded bytes`)
  }
  const frozenInputSha256 = sha256(input.frozenInputBytes)
  if (frozenInputSha256 !== task.inputSha256.toLowerCase()) {
    throw new HumanArmEvidenceError("INPUT_HASH_MISMATCH", `${task.taskId} input bytes do not match the frozen task hash`)
  }
  for (const field of task.answerFields) {
    if (typeof session.answer[field] !== "string" || session.answer[field]?.trim().length === 0) {
      throw new HumanArmEvidenceError("ANSWER_SHAPE", `${task.taskId} session is missing ${field}`)
    }
  }

  const agentAnswer = adaptAgentAnswer(task.taskId, input.agentArtifact)
  const normalizedHumanAnswer = adaptHumanAnswer(task.taskId, session.answer)
  const comparison = compareHumanArm(
    { ...session, answer: normalizedHumanAnswer },
    input.agent,
    agentAnswer,
  )

  return {
    schemaVersion: "knot.human-arm.comparison/2",
    recordedAtUtc: input.recordedAtUtc,
    taskId: task.taskId,
    frozenInputSha256,
    sessionSha256: sha256(input.sessionBytes),
    agentArtifactSha256: sha256(input.agentArtifactBytes),
    sessionPath: input.sessionPath,
    agent: input.agent,
    agentAnswer,
    humanAnswer: { ...session.answer },
    normalizedHumanAnswer,
    comparison,
  }
}

export function adaptAgentAnswer(taskId: HumanArmTaskId, artifact: unknown): Record<string, string> {
  const value = record(artifact, `${taskId} agent artifact`)
  if (taskId === "yield-1188") {
    const selectedMarketId = requiredString(value.selectedMarketId, "yield selected market")
    const markets = Array.isArray(value.eligibleMarkets) ? value.eligibleMarkets : null
    const selected = markets?.map((market) => record(market, "yield eligible market"))
      .find((market) => market.marketId === selectedMarketId)
    if (!selected) throw new HumanArmEvidenceError("ARTIFACT_SHAPE", "yield selected market has no result row")
    return {
      recommendedMarketId: selectedMarketId,
      decision: requiredString(value.recommendation, "yield recommendation") === "MIGRATE" ? "move" : "stay",
      netBenefitUnitsOverHorizon: requiredString(selected.improvementVsHoldUnits, "yield net benefit"),
      excludedMarketsAndWhy: adaptYieldExclusions(value.excludedMarkets),
    }
  }
  if (taskId === "grid-1187") {
    const result = record(value.result ?? value, "grid result")
    const levels = Array.isArray(result.levels) ? result.levels : null
    const capital = record(result.capital, "grid capital")
    if (!levels) throw new HumanArmEvidenceError("ARTIFACT_SHAPE", "grid result has no levels")
    return {
      decision: requiredString(result.outcome, "grid outcome") === "PLAN" ? "viable" : "not_viable",
      levelCount: String(levels.length),
      totalCapitalCommittedQuoteUnits: requiredString(capital.maximumCommittedQuoteUnits, "grid committed capital"),
      rejectedParametersAndWhy: requiredString(result.outcome, "grid outcome") === "PLAN" ? "none" : requiredString(value.reasonCode, "grid refusal reason").toLowerCase(),
    }
  }
  const currentState = record(value.currentState, "range current state")
  const unavailable = Array.isArray(value.unavailableMetrics) && value.unavailableMetrics.every((item) => typeof item === "string")
    ? value.unavailableMetrics as string[]
    : null
  if (!unavailable) throw new HumanArmEvidenceError("ARTIFACT_SHAPE", "range result has no unavailable metrics")
  return {
    decision: requiredString(value.decision, "range decision").toLowerCase(),
    currentTickRelativeToRange: normalizeRangePosition(requiredString(currentState.condition, "range condition")),
    unavailableMetrics: normalizeMetricList(unavailable.join(",")),
  }
}

export function adaptHumanAnswer(taskId: HumanArmTaskId, answer: Record<string, string>): Record<string, string> {
  if (taskId === "yield-1188") {
    return {
      ...pick(answer, ["recommendedMarketId", "decision", "netBenefitUnitsOverHorizon"]),
      excludedMarketsAndWhy: normalizeYieldExclusions(requiredAnswer(answer, "excludedMarketsAndWhy")),
    }
  }
  if (taskId === "grid-1187") {
    const decision = requiredAnswer(answer, "decision").toLowerCase()
    return {
      decision: /not\s+viable|invalid|reject|refuse/.test(decision) ? "not_viable" : /viable|plan|yes/.test(decision) ? "viable" : decision,
      levelCount: digits(requiredAnswer(answer, "levelCount")),
      totalCapitalCommittedQuoteUnits: digits(requiredAnswer(answer, "totalCapitalCommittedQuoteUnits")),
      rejectedParametersAndWhy: normalizeNone(requiredAnswer(answer, "rejectedParametersAndWhy")),
    }
  }
  return {
    decision: requiredAnswer(answer, "decision").trim().toLowerCase(),
    currentTickRelativeToRange: normalizeRangePosition(requiredAnswer(answer, "currentTickRelativeToRange")),
    unavailableMetrics: normalizeMetricList(requiredAnswer(answer, "unavailableMetrics")),
  }
}

function taskContract(taskId: HumanArmTaskId): {
  category: FrozenHumanArmTask["category"]
  experimentPath: string
  answerFields: readonly string[]
} {
  if (taskId === "yield-1188") return {
    category: "yield",
    experimentPath: "evidence/advantage/yieldscout-1188",
    answerFields: ["recommendedMarketId", "decision", "netBenefitUnitsOverHorizon", "excludedMarketsAndWhy"],
  }
  if (taskId === "grid-1187") return {
    category: "grid",
    experimentPath: "evidence/advantage/gridquant-1187",
    answerFields: ["decision", "levelCount", "totalCapitalCommittedQuoteUnits", "rejectedParametersAndWhy"],
  }
  if (taskId === "range-1189") return {
    category: "rebalancing",
    experimentPath: "evidence/advantage/rangepilot-1189",
    answerFields: ["decision", "currentTickRelativeToRange", "reason", "unavailableMetrics"],
  }
  throw new HumanArmEvidenceError("TASK_MISMATCH", `unsupported human-arm task ${String(taskId)}`)
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HumanArmEvidenceError("ARTIFACT_SHAPE", `${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HumanArmEvidenceError("ARTIFACT_SHAPE", `${label} is missing`)
  }
  return value
}

function requiredAnswer(answer: Record<string, string>, field: string): string {
  const value = answer[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HumanArmEvidenceError("ANSWER_SHAPE", `human answer is missing ${field}`)
  }
  return value
}

function pick(answer: Record<string, string>, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, requiredAnswer(answer, field)]))
}

function digits(value: string): string {
  const normalized = value.replace(/[,_\s]/g, "")
  return /^\d+$/.test(normalized) ? normalized : value.trim().toLowerCase()
}

function normalizeNone(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[.]/g, "")
  return /^(none|no|n\/a|not applicable|no rejected parameters)$/.test(normalized) ? "none" : normalized
}

function normalizeYieldExclusions(value: string): string {
  if (/^none(?:\b|[.])/i.test(value.trim())) return "none"
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function adaptYieldExclusions(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new HumanArmEvidenceError("ARTIFACT_SHAPE", "yield excluded markets are missing")
  }
  if (value.length === 0) return "none"
  return value.map((item) => {
    const excluded = record(item, "yield excluded market")
    const marketId = requiredString(excluded.marketId, "yield excluded market id")
    const reason = requiredString(excluded.reasonCode ?? excluded.reason, "yield excluded market reason")
    return `${marketId}:${reason}`.toLowerCase()
  }).sort().join("|")
}

function normalizeRangePosition(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[_-]/g, " ")
  if (/in range|inside|within/.test(normalized)) return "in_range"
  if (/below/.test(normalized)) return "below_range"
  if (/above/.test(normalized)) return "above_range"
  return normalized.replace(/\s+/g, "_")
}

function normalizeMetricList(value: string): string {
  const normalized = value.toLowerCase()
  const known = ["historical time in range", "future yield", "realized fees", "swap price impact"]
    .filter((metric) => normalized.includes(metric))
    .sort()
  return known.length > 0
    ? known.join("|")
    : normalized.split(/[,;|]/).map((item) => item.trim()).filter(Boolean).sort().join("|")
}
