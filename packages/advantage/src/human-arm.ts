export class HumanArmRejected extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "HumanArmRejected"
    this.code = code
  }
}

export interface RecordedHumanSession {
  schemaVersion: string
  taskId: string
  operatorPseudonym: string
  priorFamiliarity: string
  startedAtUtc: string
  endedAtUtc: string
  elapsedMillisecondsMeasured: number
  measurement: string
  answer: Record<string, string>
  toolsUsed: readonly string[]
  assistanceReceived: string
  operatorNotes: string
}

export interface AgentArmObservation {
  category: string
  experimentPath: string
  lifecycleStartUtc: string
  lifecycleEndUtc: string
  lifecycleMilliseconds: number
  serviceFeeUnits: string
  serviceFeeSymbol: string
  networkFeeUnits: string
  networkFeeSymbol: string
}

export interface HumanArmComparison {
  taskId: string
  category: string
  operatorPseudonym: string
  priorFamiliarity: string
  humanMilliseconds: number
  agentMilliseconds: number
  timeRatio: string
  absoluteMillisecondsSaved: number
  answersAgree: boolean
  disagreeingFields: readonly string[]
  serviceFeeUnits: string
  serviceFeeSymbol: string
  networkFeeUnits: string
  networkFeeSymbol: string
  observations: number
  limitations: readonly string[]
}

const ASSISTED = /ai|assistant|codex|copilot|model|generated|simulat/i

export function assertUnaided(session: RecordedHumanSession): void {
  if (session.assistanceReceived.trim().length > 0 && session.assistanceReceived.trim() !== "none") {
    throw new HumanArmRejected(
      "ASSISTED_SESSION",
      `session ${session.operatorPseudonym} records assistance and cannot support a human-effort claim`,
    )
  }
  for (const tool of session.toolsUsed) {
    if (ASSISTED.test(tool)) {
      throw new HumanArmRejected(
        "ASSISTED_TOOL",
        `session ${session.operatorPseudonym} lists ${tool}, which cannot appear in an unaided run`,
      )
    }
  }
  if (ASSISTED.test(session.operatorNotes)) {
    const disclosure = session.operatorNotes.match(/[^.]*(?:simulat|model-generated)[^.]*\./i)
    if (disclosure) {
      throw new HumanArmRejected(
        "SIMULATED_SESSION",
        `session ${session.operatorPseudonym} declares: ${disclosure[0].trim()}`,
      )
    }
  }
}

export function assertMeasured(session: RecordedHumanSession): void {
  const wall = Date.parse(session.endedAtUtc) - Date.parse(session.startedAtUtc)
  if (!Number.isFinite(wall)) {
    throw new HumanArmRejected("UNPARSEABLE_WINDOW", "session timestamps are not parseable")
  }
  if (Math.abs(wall - session.elapsedMillisecondsMeasured) > 2_000) {
    throw new HumanArmRejected(
      "WINDOW_DISAGREES",
      `recorded elapsed ${session.elapsedMillisecondsMeasured}ms disagrees with its own window of ${wall}ms`,
    )
  }
  if (session.elapsedMillisecondsMeasured <= 0) {
    throw new HumanArmRejected("NON_POSITIVE_WINDOW", "measured elapsed time must be positive")
  }
  if (session.elapsedMillisecondsMeasured % 30_000 === 0) {
    throw new HumanArmRejected(
      "SUSPICIOUSLY_ROUND_WINDOW",
      `an elapsed time of exactly ${session.elapsedMillisecondsMeasured}ms is not a measured wall clock`,
    )
  }
}

export function compareHumanArm(
  session: RecordedHumanSession,
  agent: AgentArmObservation,
  agentAnswer: Record<string, string>,
): HumanArmComparison {
  assertUnaided(session)
  assertMeasured(session)
  if (agent.lifecycleMilliseconds <= 0) {
    throw new HumanArmRejected("AGENT_WINDOW_INVALID", "agent lifecycle must be positive")
  }

  const disagreeing = Object.keys(agentAnswer).filter(
    (field) => field in session.answer && session.answer[field] !== agentAnswer[field],
  )

  return {
    taskId: session.taskId,
    category: agent.category,
    operatorPseudonym: session.operatorPseudonym,
    priorFamiliarity: session.priorFamiliarity,
    humanMilliseconds: session.elapsedMillisecondsMeasured,
    agentMilliseconds: agent.lifecycleMilliseconds,
    timeRatio: (session.elapsedMillisecondsMeasured / agent.lifecycleMilliseconds).toFixed(2),
    absoluteMillisecondsSaved: session.elapsedMillisecondsMeasured - agent.lifecycleMilliseconds,
    answersAgree: disagreeing.length === 0,
    disagreeingFields: disagreeing,
    serviceFeeUnits: agent.serviceFeeUnits,
    serviceFeeSymbol: agent.serviceFeeSymbol,
    networkFeeUnits: agent.networkFeeUnits,
    networkFeeSymbol: agent.networkFeeSymbol,
    observations: 1,
    limitations: [
      "One operator on one task. No population claim is supported by a single observation.",
      "The time boundaries are not identical: the agent window runs from recorded marketplace start through confirmed on-chain submission and includes block inclusion, while the operator window covers task work only.",
      `Costs are ${agent.serviceFeeSymbol} and ${agent.networkFeeSymbol} on BSC testnet. Testnet units are not dollars and no monetary break-even is claimed.`,
      "The operator worked from the identical frozen input, and the recorder held the clock rather than accepting a stated duration.",
    ],
  }
}
