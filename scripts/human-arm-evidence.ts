#!/usr/bin/env node
import { isDeepStrictEqual } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildHumanArmEvidence,
  HumanArmEvidenceError,
  type BuiltHumanArmEvidence,
  type FrozenHumanArmTask,
  type HumanArmTaskId,
} from "../packages/advantage/src/human-arm-evidence.ts"
import type { AgentArmObservation, RecordedHumanSession } from "../packages/advantage/src/human-arm.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const agentByTask: Record<HumanArmTaskId, AgentArmObservation> = {
  "yield-1188": {
    category: "yield",
    experimentPath: "evidence/advantage/yieldscout-1188",
    lifecycleStartUtc: "2026-09-09T11:15:24.627Z",
    lifecycleEndUtc: "2026-09-09T11:17:53.000Z",
    lifecycleMilliseconds: 148_373,
    serviceFeeUnits: "100000000000000000",
    serviceFeeSymbol: "U",
    networkFeeUnits: "2168994000000000",
    networkFeeSymbol: "tBNB",
  },
  "grid-1187": {
    category: "grid",
    experimentPath: "evidence/advantage/gridquant-1187",
    lifecycleStartUtc: "2026-09-09T11:15:24.382Z",
    lifecycleEndUtc: "2026-09-09T11:16:58.000Z",
    lifecycleMilliseconds: 93_618,
    serviceFeeUnits: "100000000000000000",
    serviceFeeSymbol: "U",
    networkFeeUnits: "1783262000000000",
    networkFeeSymbol: "tBNB",
  },
  "range-1189": {
    category: "rebalancing",
    experimentPath: "evidence/advantage/rangepilot-1189",
    lifecycleStartUtc: "2026-09-09T11:15:24.600Z",
    lifecycleEndUtc: "2026-09-09T11:18:48.000Z",
    lifecycleMilliseconds: 203_400,
    serviceFeeUnits: "100000000000000000",
    serviceFeeSymbol: "U",
    networkFeeUnits: "2078536000000000",
    networkFeeSymbol: "tBNB",
  },
}

const artifactPathByTask: Record<HumanArmTaskId, string> = {
  "yield-1188": "evidence/advantage/yieldscout-1188/agent-artifact.json",
  "grid-1187": "evidence/advantage/gridquant-1187/agent-artifact.json",
  "range-1189": "evidence/advantage/rangepilot-1189/agent-artifact.json",
}

export async function buildEvidenceForRecordedSession(
  taskId: HumanArmTaskId,
  sessionPath: string,
  recordedAtUtc = new Date().toISOString(),
): Promise<BuiltHumanArmEvidence> {
  const taskDirectory = resolve(ROOT, "experiments/human-arm", taskId)
  const absoluteSessionPath = resolve(ROOT, sessionPath)
  if (relative(taskDirectory, absoluteSessionPath).startsWith("..")) {
    throw new HumanArmEvidenceError("TASK_MISMATCH", "session path is outside its frozen task directory")
  }
  const [taskBytes, inputBytes, sessionBytes, agentArtifactBytes] = await Promise.all([
    readFile(resolve(taskDirectory, "task.json")),
    readFile(resolve(taskDirectory, "input.json")),
    readFile(absoluteSessionPath),
    readFile(resolve(ROOT, artifactPathByTask[taskId])),
  ]).catch((error: unknown) => {
    throw new HumanArmEvidenceError("MISSING_EVIDENCE", error instanceof Error ? error.message : "required evidence is missing")
  })
  return buildHumanArmEvidence({
    task: JSON.parse(taskBytes.toString("utf8")) as FrozenHumanArmTask,
    frozenInputBytes: inputBytes,
    session: JSON.parse(sessionBytes.toString("utf8")) as RecordedHumanSession,
    sessionBytes,
    agent: agentByTask[taskId],
    agentArtifact: JSON.parse(agentArtifactBytes.toString("utf8")) as unknown,
    agentArtifactBytes,
    sessionPath,
    recordedAtUtc,
  })
}

export async function verifyStoredHumanArmEvidence(
  artifact: BuiltHumanArmEvidence,
): Promise<BuiltHumanArmEvidence> {
  const rebuilt = await buildEvidenceForRecordedSession(artifact.taskId, artifact.sessionPath, artifact.recordedAtUtc)
  if (!isDeepStrictEqual(rebuilt, artifact)) {
    throw new HumanArmEvidenceError("INPUT_HASH_MISMATCH", `${artifact.taskId} stored comparison does not match its source evidence`)
  }
  return rebuilt
}

async function main(): Promise<void> {
  const taskId = process.argv[2] as HumanArmTaskId | undefined
  const sessionPath = process.argv[3]
  const outputPath = process.argv[4]
  if (!taskId || !(taskId in agentByTask) || !sessionPath || !outputPath) {
    throw new Error("usage: human-arm-evidence <yield-1188|grid-1187|range-1189> <session-path> <output-path>")
  }
  const artifact = await buildEvidenceForRecordedSession(taskId, sessionPath)
  await writeFile(resolve(ROOT, outputPath), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" })
  process.stderr.write(`wrote verified human-arm evidence to ${outputPath}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
