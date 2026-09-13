import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  adaptAgentAnswer,
  buildHumanArmEvidence,
  HumanArmEvidenceError,
  type FrozenHumanArmTask,
} from "../../packages/advantage/src/human-arm-evidence.ts"
import { HumanArmRejected, type AgentArmObservation, type RecordedHumanSession } from "../../packages/advantage/src/human-arm.ts"
import { buildEvidenceForRecordedSession, verifyStoredHumanArmEvidence } from "../../scripts/human-arm-evidence.ts"

const task = async (taskId: "grid-1187" | "range-1189"): Promise<FrozenHumanArmTask> =>
  JSON.parse(await readFile(`experiments/human-arm/${taskId}/task.json`, "utf8")) as FrozenHumanArmTask

const agent: AgentArmObservation = {
  category: "grid",
  experimentPath: "evidence/advantage/gridquant-1187",
  lifecycleStartUtc: "2026-09-09T11:15:24.382Z",
  lifecycleEndUtc: "2026-09-09T11:16:58.000Z",
  lifecycleMilliseconds: 93_618,
  serviceFeeUnits: "100000000000000000",
  serviceFeeSymbol: "U",
  networkFeeUnits: "1783262000000000",
  networkFeeSymbol: "tBNB",
}

const gridSession = (): RecordedHumanSession => ({
  schemaVersion: "knot.human-arm.session/1",
  taskId: "grid-1187",
  operatorPseudonym: "test-participant",
  priorFamiliarity: "none",
  startedAtUtc: "2026-09-13T10:00:00.000Z",
  endedAtUtc: "2026-09-13T10:04:31.117Z",
  elapsedMillisecondsMeasured: 271_117,
  measurement: "wall-clock, measured by this recorder between start and stop",
  answer: {
    decision: "Viable as specified",
    levelCount: "5",
    totalCapitalCommittedQuoteUnits: "1_000_000_000_000_000_000_000",
    rejectedParametersAndWhy: "No rejected parameters.",
  },
  toolsUsed: ["calculator"],
  assistanceReceived: "none",
  operatorNotes: "",
})

test("Yield, Grid, and Range adapters derive objective answers from retained paid artifacts", async () => {
  const yieldArtifact = JSON.parse(await readFile("evidence/advantage/yieldscout-1188/agent-artifact.json", "utf8")) as unknown
  assert.deepEqual(adaptAgentAnswer("yield-1188", yieldArtifact), {
    recommendedMarketId: "aave-v3-usdt",
    decision: "move",
    netBenefitUnitsOverHorizon: "1501501839029449362",
    excludedMarketsAndWhy: "none",
  })
  const grid = JSON.parse(await readFile("evidence/advantage/gridquant-1187/agent-artifact.json", "utf8")) as unknown
  assert.deepEqual(adaptAgentAnswer("grid-1187", grid), {
    decision: "viable",
    levelCount: "5",
    totalCapitalCommittedQuoteUnits: "1000000000000000000000",
    rejectedParametersAndWhy: "none",
  })
  const range = JSON.parse(await readFile("evidence/advantage/rangepilot-1189/agent-artifact.json", "utf8")) as unknown
  assert.deepEqual(adaptAgentAnswer("range-1189", range), {
    decision: "hold",
    currentTickRelativeToRange: "in_range",
    unavailableMetrics: "future yield|historical time in range|realized fees|swap price impact",
  })
})

test("a complete Grid session builds a source-bound comparison without inventing a session", async () => {
  const inputBytes = await readFile("experiments/human-arm/grid-1187/input.json")
  const session = gridSession()
  const sessionBytes = Buffer.from(JSON.stringify(session))
  const artifactBytes = await readFile("evidence/advantage/gridquant-1187/agent-artifact.json")
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as unknown
  const result = buildHumanArmEvidence({
    task: await task("grid-1187"), frozenInputBytes: inputBytes, session, sessionBytes, agent,
    agentArtifact: artifact, agentArtifactBytes: artifactBytes,
    sessionPath: "experiments/human-arm/grid-1187/manual-session-test-participant.json",
    recordedAtUtc: "2026-09-13T10:04:31.200Z",
  })
  assert.equal(result.comparison.answersAgree, true)
  assert.deepEqual(result.comparison.disagreeingFields, [])
  assert.equal(result.humanAnswer.decision, "Viable as specified")
  assert.equal(result.normalizedHumanAnswer.decision, "viable")
})

test("missing source evidence fails closed", async () => {
  assert.throws(
    () => buildHumanArmEvidence({
      task: undefined, frozenInputBytes: undefined, session: undefined, sessionBytes: undefined,
      agent: undefined, agentArtifact: undefined, agentArtifactBytes: undefined,
      sessionPath: "", recordedAtUtc: "2026-09-13T00:00:00Z",
    }),
    (error: unknown) => error instanceof HumanArmEvidenceError && error.code === "MISSING_EVIDENCE",
  )
  await assert.rejects(
    buildEvidenceForRecordedSession("grid-1187", "experiments/human-arm/grid-1187/missing.json"),
    (error: unknown) => error instanceof HumanArmEvidenceError && error.code === "MISSING_EVIDENCE",
  )
})

test("tampered frozen input fails before comparison", async () => {
  const inputBytes = Buffer.concat([await readFile("experiments/human-arm/grid-1187/input.json"), Buffer.from(" ")])
  const frozenTask = await task("grid-1187")
  const session = gridSession()
  const artifactBytes = await readFile("evidence/advantage/gridquant-1187/agent-artifact.json")
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as unknown
  assert.throws(
    () => buildHumanArmEvidence({
      task: frozenTask, frozenInputBytes: inputBytes, session,
      sessionBytes: Buffer.from(JSON.stringify(session)), agent, agentArtifact: artifact, agentArtifactBytes: artifactBytes,
      sessionPath: "experiments/human-arm/grid-1187/manual-session-test-participant.json",
      recordedAtUtc: "2026-09-13T10:04:31.200Z",
    }),
    (error: unknown) => error instanceof HumanArmEvidenceError && error.code === "INPUT_HASH_MISMATCH",
  )
})

test("agent answer objects cannot diverge from their bound artifact bytes", async () => {
  const inputBytes = await readFile("experiments/human-arm/grid-1187/input.json")
  const frozenTask = await task("grid-1187")
  const session = gridSession()
  const artifactBytes = await readFile("evidence/advantage/gridquant-1187/agent-artifact.json")
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as Record<string, unknown>
  assert.throws(
    () => buildHumanArmEvidence({
      task: frozenTask, frozenInputBytes: inputBytes, session,
      sessionBytes: Buffer.from(JSON.stringify(session)), agent,
      agentArtifact: { ...artifact, reasonCode: "CHANGED_AFTER_RECORDING" }, agentArtifactBytes: artifactBytes,
      sessionPath: "experiments/human-arm/grid-1187/manual-session-test-participant.json",
      recordedAtUtc: "2026-09-13T10:04:31.200Z",
    }),
    (error: unknown) => error instanceof HumanArmEvidenceError && error.code === "INPUT_HASH_MISMATCH",
  )
})

test("assisted sessions remain ineligible", async () => {
  const inputBytes = await readFile("experiments/human-arm/grid-1187/input.json")
  const frozenTask = await task("grid-1187")
  const session = { ...gridSession(), assistanceReceived: "AI assistant" }
  const artifactBytes = await readFile("evidence/advantage/gridquant-1187/agent-artifact.json")
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as unknown
  assert.throws(
    () => buildHumanArmEvidence({
      task: frozenTask, frozenInputBytes: inputBytes, session,
      sessionBytes: Buffer.from(JSON.stringify(session)), agent, agentArtifact: artifact, agentArtifactBytes: artifactBytes,
      sessionPath: "experiments/human-arm/grid-1187/manual-session-test-participant.json",
      recordedAtUtc: "2026-09-13T10:04:31.200Z",
    }),
    (error: unknown) => error instanceof HumanArmRejected && error.code === "ASSISTED_SESSION",
  )
})

test("a stored comparison is rejected when a result is changed after source binding", async () => {
  const artifact = await buildEvidenceForRecordedSession(
    "yield-1188",
    "experiments/human-arm/yield-1188/manual-session-participant-1.json",
    "2026-09-13T00:00:00.000Z",
  )
  await assert.doesNotReject(verifyStoredHumanArmEvidence(artifact))
  const tampered = {
    ...artifact,
    comparison: { ...artifact.comparison, timeRatio: "99.99" },
  }
  await assert.rejects(
    verifyStoredHumanArmEvidence(tampered),
    (error: unknown) => error instanceof HumanArmEvidenceError && error.code === "INPUT_HASH_MISMATCH",
  )
})
