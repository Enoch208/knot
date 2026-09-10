import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  HumanArmError,
  buildSession,
  readFrozenTask,
  type OpenSession,
} from "../../scripts/record-human-arm.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const openSession = (startedAtMonotonicMs: number): OpenSession => ({
  schemaVersion: "knot.human-arm.session-open/1",
  taskId: "health-1185",
  operatorPseudonym: "operator-a",
  priorFamiliarity: "none",
  startedAtUtc: "2026-09-10T12:00:00.000Z",
  startedAtMonotonicMs,
})

const answer = {
  totalCollateralValue: "0",
  totalDebtValue: "0",
  healthState: "NO_DEBT",
  recommendedAction: "none",
}

test("elapsed time is derived from the recorder clock, never from operator input", () => {
  const session = buildSession(
    openSession(1_000),
    "2026-09-10T12:11:42.000Z",
    1_000 + 702_000,
    answer,
    ["explorer"],
    "none",
    "",
  )
  assert.equal(session.elapsedMillisecondsMeasured, 702_000)
  assert.match(session.measurement, /measured by this recorder/)
})

test("a non-advancing clock is refused rather than recorded as instant work", () => {
  assert.throws(
    () => buildSession(openSession(5_000), "2026-09-10T12:00:00.000Z", 5_000, answer, [], "none", ""),
    HumanArmError,
  )
})

test("a clock that runs backwards is refused", () => {
  assert.throws(
    () => buildSession(openSession(9_000), "2026-09-10T12:00:00.000Z", 1_000, answer, [], "none", ""),
    HumanArmError,
  )
})

test("the recorded session preserves the operator pseudonym and prior familiarity", () => {
  const session = buildSession(openSession(0), "2026-09-10T12:05:00.000Z", 300_000, answer, [], "none", "")
  assert.equal(session.operatorPseudonym, "operator-a")
  assert.equal(session.priorFamiliarity, "none")
})

test("the frozen health task pins the same input the paid agent received", async () => {
  const task = await readFrozenTask("health-1185")
  const frozenInput = await readFile(
    join(ROOT, "experiments", "human-arm", "health-1185", "input.json"),
    "utf8",
  )
  const agentInput = await readFile(
    join(ROOT, "evidence", "advantage", "healthguard-1185", "input.json"),
    "utf8",
  )
  assert.equal(frozenInput, agentInput, "the human arm must receive byte-identical input to the agent")
  assert.equal(task.inputSha256, `0x${createHash("sha256").update(frozenInput).digest("hex")}`)
})

test("the frozen task forbids reaching for KNOT or a previously seen answer", async () => {
  const task = await readFrozenTask("health-1185")
  const forbidden = task.forbidden.join(" ").toLowerCase()
  assert.match(forbidden, /knot/)
  assert.match(forbidden, /previously seen answer/)
  assert.ok(task.answerFields.length >= 4)
})

test("an unknown task refuses instead of inventing a frozen definition", async () => {
  await assert.rejects(readFrozenTask("not-a-real-task"), HumanArmError)
})
