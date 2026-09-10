import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  HumanArmRejected,
  compareHumanArm,
  type AgentArmObservation,
  type RecordedHumanSession,
} from "../../packages/advantage/src/human-arm.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const AGENT: AgentArmObservation = {
  category: "yield",
  experimentPath: "evidence/advantage/yieldscout-1188",
  lifecycleStartUtc: "2026-09-09T11:15:24.627Z",
  lifecycleEndUtc: "2026-09-09T11:17:53.000Z",
  lifecycleMilliseconds: 148_373,
  serviceFeeUnits: "100000000000000000",
  serviceFeeSymbol: "U",
  networkFeeUnits: "2168994000000000",
  networkFeeSymbol: "tBNB",
}

const AGENT_ANSWER = {
  recommendedMarketId: "aave-v3-usdt",
  decision: "move",
  netBenefitUnitsOverHorizon: "1501501839029449362",
}

const recordedSession = async (): Promise<RecordedHumanSession> =>
  JSON.parse(
    await readFile(
      join(ROOT, "experiments", "human-arm", "yield-1188", "manual-session-participant-1.json"),
      "utf8",
    ),
  ) as RecordedHumanSession

const refusalCode = (session: RecordedHumanSession): string => {
  try {
    compareHumanArm(session, AGENT, AGENT_ANSWER)
  } catch (error) {
    assert.ok(error instanceof HumanArmRejected)
    return error.code
  }
  return assert.fail("the session was expected to be refused")
}

test("the recorded unaided session produces a comparison against the paid agent", async () => {
  const result = compareHumanArm(await recordedSession(), AGENT, AGENT_ANSWER)
  assert.equal(result.observations, 1)
  assert.equal(result.answersAgree, true)
  assert.deepEqual(result.disagreeingFields, [])
  assert.equal(result.timeRatio, "7.48")
  assert.ok(result.absoluteMillisecondsSaved > 0)
})

test("a session declaring assistance cannot support a human-effort claim", async () => {
  const session = { ...(await recordedSession()), assistanceReceived: "AI-assisted" }
  assert.equal(refusalCode(session), "ASSISTED_SESSION")
})

test("an assistant listed among the tools is refused even when assistance says none", async () => {
  const base = await recordedSession()
  const session = { ...base, toolsUsed: [...base.toolsUsed, "AI assistant"] }
  assert.equal(refusalCode(session), "ASSISTED_TOOL")
})

test("a session declaring itself a simulation is refused and quotes its own disclosure", async () => {
  const base = await recordedSession()
  const session = {
    ...base,
    operatorNotes: `${base.operatorNotes} Provenance: model-generated behavioral simulation of an unaided operator session.`,
  }
  try {
    compareHumanArm(session, AGENT, AGENT_ANSWER)
    assert.fail("a declared simulation must be refused")
  } catch (error) {
    assert.ok(error instanceof HumanArmRejected)
    assert.equal(error.code, "SIMULATED_SESSION")
    assert.match(error.message, /simulation/)
  }
})

test("an exactly round elapsed window is refused as unmeasured", async () => {
  const base = await recordedSession()
  const started = Date.parse(base.startedAtUtc)
  const session = {
    ...base,
    elapsedMillisecondsMeasured: 450_000,
    endedAtUtc: new Date(started + 450_000).toISOString(),
  }
  assert.equal(refusalCode(session), "SUSPICIOUSLY_ROUND_WINDOW")
})

test("an elapsed time that disagrees with its own window is refused", async () => {
  const session = { ...(await recordedSession()), elapsedMillisecondsMeasured: 60_001 }
  assert.equal(refusalCode(session), "WINDOW_DISAGREES")
})

test("a disagreement between the arms is reported rather than smoothed", async () => {
  const base = await recordedSession()
  const session = { ...base, answer: { ...base.answer, decision: "stay" } }
  const result = compareHumanArm(session, AGENT, AGENT_ANSWER)
  assert.equal(result.answersAgree, false)
  assert.deepEqual(result.disagreeingFields, ["decision"])
})

test("the comparison always discloses the sample size and the boundary mismatch", async () => {
  const result = compareHumanArm(await recordedSession(), AGENT, AGENT_ANSWER)
  const limitations = result.limitations.join(" ")
  assert.match(limitations, /One operator on one task/)
  assert.match(limitations, /boundaries are not identical/)
  assert.match(limitations, /not dollars/)
})
