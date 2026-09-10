#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const EXPERIMENTS = join(ROOT, "experiments", "human-arm")

export class HumanArmError extends Error {}

export interface FrozenTask {
  schemaVersion: "knot.human-arm.task/1"
  taskId: string
  category: string
  frozenAtUtc: string
  inputSha256: string
  question: string
  allowedTools: readonly string[]
  forbidden: readonly string[]
  answerFields: readonly string[]
}

export interface OpenSession {
  schemaVersion: "knot.human-arm.session-open/1"
  taskId: string
  operatorPseudonym: string
  priorFamiliarity: "none" | "some" | "expert"
  startedAtUtc: string
  startedAtMonotonicMs: number
}

export interface ManualSession {
  schemaVersion: "knot.human-arm.session/1"
  taskId: string
  operatorPseudonym: string
  priorFamiliarity: "none" | "some" | "expert"
  startedAtUtc: string
  endedAtUtc: string
  elapsedMillisecondsMeasured: number
  measurement: "wall-clock, measured by this recorder between start and stop"
  answer: Record<string, string>
  toolsUsed: readonly string[]
  assistanceReceived: string
  operatorNotes: string
}

const sessionPath = (taskId: string): string => join(EXPERIMENTS, taskId, "session-open.json")
const taskPath = (taskId: string): string => join(EXPERIMENTS, taskId, "task.json")

export async function readFrozenTask(taskId: string): Promise<FrozenTask> {
  try {
    return JSON.parse(await readFile(taskPath(taskId), "utf8")) as FrozenTask
  } catch {
    throw new HumanArmError(`no frozen task at experiments/human-arm/${taskId}/task.json`)
  }
}

export function buildSession(
  open: OpenSession,
  endedAtUtc: string,
  endedAtMonotonicMs: number,
  answer: Record<string, string>,
  toolsUsed: readonly string[],
  assistanceReceived: string,
  operatorNotes: string,
): ManualSession {
  const elapsed = Math.round(endedAtMonotonicMs - open.startedAtMonotonicMs)
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    throw new HumanArmError("measured elapsed time must be positive; the session clock is unusable")
  }
  return {
    schemaVersion: "knot.human-arm.session/1",
    taskId: open.taskId,
    operatorPseudonym: open.operatorPseudonym,
    priorFamiliarity: open.priorFamiliarity,
    startedAtUtc: open.startedAtUtc,
    endedAtUtc,
    elapsedMillisecondsMeasured: elapsed,
    measurement: "wall-clock, measured by this recorder between start and stop",
    answer,
    toolsUsed,
    assistanceReceived,
    operatorNotes,
  }
}

const flag = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
}

async function start(taskId: string): Promise<void> {
  const task = await readFrozenTask(taskId)
  const operator = flag("operator")
  const familiarity = flag("familiarity")
  if (!operator) throw new HumanArmError("--operator <pseudonym> is required")
  if (familiarity !== "none" && familiarity !== "some" && familiarity !== "expert") {
    throw new HumanArmError("--familiarity must be none, some or expert")
  }

  const open: OpenSession = {
    schemaVersion: "knot.human-arm.session-open/1",
    taskId,
    operatorPseudonym: operator,
    priorFamiliarity: familiarity,
    startedAtUtc: new Date().toISOString(),
    startedAtMonotonicMs: performance.now() + performance.timeOrigin,
  }
  await mkdir(join(EXPERIMENTS, taskId), { recursive: true })
  await writeFile(sessionPath(taskId), `${JSON.stringify(open, null, 2)}\n`)

  process.stderr.write(`\n  TASK ${task.taskId} — the clock is running.\n\n`)
  process.stderr.write(`  ${task.question}\n\n`)
  process.stderr.write(`  Allowed: ${task.allowedTools.join(", ")}\n`)
  process.stderr.write(`  Forbidden: ${task.forbidden.join(", ")}\n\n`)
  process.stderr.write(`  Answer these when you stop: ${task.answerFields.join(", ")}\n\n`)
  process.stderr.write(`  When finished run:\n    npm run human-arm -- stop ${taskId} --answer '{"field":"value"}' --tools "explorer,calculator" --assistance none --notes ""\n\n`)
}

async function stop(taskId: string): Promise<void> {
  let open: OpenSession
  try {
    open = JSON.parse(await readFile(sessionPath(taskId), "utf8")) as OpenSession
  } catch {
    throw new HumanArmError(`no open session for ${taskId}; run start first`)
  }
  const answerRaw = flag("answer")
  if (!answerRaw) throw new HumanArmError("--answer '<json>' is required")
  const answer = JSON.parse(answerRaw) as Record<string, string>
  const task = await readFrozenTask(taskId)
  for (const field of task.answerFields) {
    if (typeof answer[field] !== "string" || answer[field]?.length === 0) {
      throw new HumanArmError(`answer is missing the required field ${field}`)
    }
  }

  const session = buildSession(
    open,
    new Date().toISOString(),
    performance.now() + performance.timeOrigin,
    answer,
    (flag("tools") ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0),
    flag("assistance") ?? "none",
    flag("notes") ?? "",
  )

  const target = join(EXPERIMENTS, taskId, `manual-session-${open.operatorPseudonym}.json`)
  await writeFile(target, `${JSON.stringify(session, null, 2)}\n`)
  const seconds = (session.elapsedMillisecondsMeasured / 1000).toFixed(1)
  process.stderr.write(`\n  Recorded ${seconds}s of measured wall clock for ${open.operatorPseudonym}.\n`)
  process.stderr.write(`  ${target}\n\n`)
}

async function list(): Promise<void> {
  const names = await readdir(EXPERIMENTS).catch(() => [])
  for (const name of names) {
    const sessions = (await readdir(join(EXPERIMENTS, name)).catch(() => [])).filter((file) =>
      file.startsWith("manual-session-"),
    )
    process.stderr.write(`  ${name}: ${sessions.length} recorded session(s)\n`)
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const taskId = process.argv[3]
  if (command === "list") return list()
  if (!taskId) throw new HumanArmError("usage: human-arm <start|stop|list> <taskId> [flags]")
  if (command === "start") return start(taskId)
  if (command === "stop") return stop(taskId)
  throw new HumanArmError("usage: human-arm <start|stop|list> <taskId> [flags]")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`\n  ${error instanceof Error ? error.message : String(error)}\n\n`)
    process.exitCode = 1
  })
}
