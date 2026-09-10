import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import {
  AdvantageReportError,
  buildAgentAdvantageReport,
  type AdvantageDatasetSource,
  type ShieldReportSource,
} from "../../packages/advantage/src/report.ts"
import type { HumanArmComparison } from "../../packages/advantage/src/human-arm.ts"
import { AdvantageValidationError } from "../../packages/advantage/src/runner.ts"
import { ShieldMeasurementError, shieldSlitherCapture } from "../../packages/services/shield/index.ts"

const datasetConfigs = [
  {
    datasetPath: "evidence/advantage/healthguard-1185/dataset.json",
    startPath: "evidence/advantage/healthguard-1185/job-1185.json",
    startValuePath: ["a2a", "negotiation", "startedAtUtc"],
    endPath: "evidence/advantage/healthguard-1185/job-1185.json",
    endValuePath: ["transactions", "submit", "timestampUtc"],
  },
  {
    datasetPath: "evidence/advantage/rangepilot-1189/dataset.json",
    startPath: "evidence/advantage/rangepilot-1189/job-1189.json",
    startValuePath: ["agentLifecycle", "startedAtUtc"],
    endPath: "evidence/advantage/rangepilot-1189/job-1189.json",
    endValuePath: ["transactions", "submit", "timestampUtc"],
  },
  {
    datasetPath: "evidence/advantage/gridquant-1187/dataset.json",
    startPath: "evidence/advantage/gridquant-1187/agent-negotiate-observation.json",
    startValuePath: ["startedAtUtc"],
    endPath: "evidence/advantage/gridquant-1187/job-1187.json",
    endValuePath: ["transactions", "submit", "timestampUtc"],
  },
  {
    datasetPath: "evidence/advantage/yieldscout-1188/dataset.json",
    startPath: "evidence/advantage/yieldscout-1188/agent-negotiate-observation.json",
    startValuePath: ["startedAtUtc"],
    endPath: "evidence/advantage/yieldscout-1188/paid-jobs-source.json",
    endValuePath: ["jobs", 1, "transactions", "submit", "timestampUtc"],
  },
]


const loadHumanArm = async () => {
  const artifact = JSON.parse(
    await readFile("evidence/advantage/human-arm/yield-1188.json", "utf8"),
  ) as { comparison: HumanArmComparison }
  return artifact.comparison
}

test("the committed report is deterministic and derived from all four verified finance pairs", async () => {
  const sources = await loadSources()
  const shield = await loadShield()
  const humanArm = await loadHumanArm()
  const first = await buildAgentAdvantageReport(sources, shield, humanArm)
  const second = await buildAgentAdvantageReport(sources, shield, humanArm)
  const committed = await readFile("docs/AGENT_ADVANTAGE_REPORT.md", "utf8")
  assert.equal(first, second)
  assert.equal(first, committed)
  for (const service of ["HealthGuard", "RangePilot", "GridQuant", "YieldScout"]) {
    assert.equal(count(first, `| ${service} |`), 1)
  }
  assert.equal(count(first, "Task-to-input binding: exact"), 3)
  assert.equal(count(first, "Task-to-input binding: partial"), 1)
  assert.match(first, /HealthGuard[\s\S]*0xe0bcb1f88b24f805ebb73530b9c849a8074aef6be9f7f8f2efcbafc4d526fdd3/)
  assert.match(first, /same_operator_reference/)
  assert.match(first, /43,605 ms/)
  assert.match(first, /service_fee 0\.1 U \(100000000000000000 base units, chain 97\)/)
  assert.match(first, /computed later as a historical replay over frozen bytes/)
  assert.match(first, /establish no speed, latency, labor, or human-time advantage/)
  assert.match(first, /## Recorded operator session/)
  assert.match(first, /participant-1/)
  assert.match(first, /Observations: 1\./)
  assert.match(first, /No population claim is supported by a single observation/)
  assert.match(first, /No paired result establishes profit, APY, return, savings, PnL, win rate, execution quality, or future performance/)
  for (const match of first.matchAll(/\]\((\.\.\/[^)]+)\)/g)) {
    const path = match[1]
    assert.ok(path)
    assert.ok((await readFile(resolve("docs", path))).byteLength > 0, path)
  }
})

test("the report keeps the verified Shield measurement separate from marketplace pairs", async () => {
  const report = await buildAgentAdvantageReport(await loadSources(), await loadShield())
  assert.match(report, /## Shield high-stakes corpus evaluation/)
  assert.match(report, /not one of the four paired marketplace experiments/)
  assert.match(report, /2 true positives, 0 false positives, 7 false negatives/)
  assert.match(report, /precision 2\/2 \(1\.000000\), recall 2\/9 \(0\.222222\)/)
  assert.match(report, /Holdout result: 0 true positives, 0 false positives, 3 false negatives/)
  assert.match(report, /all six fixtures, labels, and manual validation decisions are team-owned/)
})

test("the public comparative claim stays within the generated report boundary", async () => {
  const ledger = JSON.parse(await readFile("evidence/claims.json", "utf8")) as {
    claims: Array<{
      id: string
      status: string
      scope: { pairedExperimentCount?: number; qualityResult?: string; exactTaskToRawInputBindingCount?: number }
      sources: Array<{ type: string; path?: string; command?: string }>
      limitations: string[]
    }>
  }
  const claim = ledger.claims.find((item) => item.id === "comparative-benchmarks")
  assert.ok(claim)
  assert.equal(claim.status, "SUPPORTED")
  assert.deepEqual(claim.scope, {
    measuredComponents: ["HealthGuard", "RangePilot", "GridQuant", "YieldScout"],
    unmeasuredComponents: [],
    experiments: [
      { service: "HealthGuard", experimentId: "healthguard-1185", qualityResult: "tie", qualityDimensionTies: 4, exactTaskToRawInputBinding: false },
      { service: "RangePilot", experimentId: "rangepilot-1189", qualityResult: "tie", qualityDimensionTies: 6, exactTaskToRawInputBinding: true },
      { service: "GridQuant", experimentId: "gridquant-1187", qualityResult: "tie", qualityDimensionTies: 5, exactTaskToRawInputBinding: true },
      { service: "YieldScout", experimentId: "yieldscout-1188", qualityResult: "tie", qualityDimensionTies: 5, exactTaskToRawInputBinding: true },
    ],
    pairedExperimentCount: 4,
    qualityResult: "four ties",
    exactTaskToRawInputBindingCount: 3,
  })
  assert.equal(claim.sources.filter((source) => source.type === "paired_experiment_dataset").length, 4)
  assert.ok(claim.sources.some((source) => source.path === "docs/AGENT_ADVANTAGE_REPORT.md"))
  assert.ok(claim.limitations.some((limitation) => limitation.includes("no authentic signed-task preimage binding")))
  assert.ok(claim.limitations.some((limitation) => limitation.includes("No speed, human-time, cost, profit")))
})

test("missing, duplicate, and tampered finance datasets fail closed", async () => {
  const sources = await loadSources()
  const shield = await loadShield()
  await assert.rejects(
    buildAgentAdvantageReport(sources.slice(0, 3), shield),
    (error: unknown) => error instanceof AdvantageReportError && error.code === "MISSING_CATEGORY",
  )
  await assert.rejects(
    buildAgentAdvantageReport([...sources.slice(0, 3), sources[0]!], shield),
    (error: unknown) => error instanceof AdvantageReportError && error.code === "DUPLICATE_CATEGORY",
  )
  const health = sources[0]!
  const tampered: AdvantageDatasetSource = {
    ...health,
    resolveEvidence: async (reference) => {
      const bytes = await health.resolveEvidence(reference)
      return reference.uri === "input.json" ? Uint8Array.from([...bytes, 0x20]) : bytes
    },
  }
  await assert.rejects(
    buildAgentAdvantageReport([tampered, ...sources.slice(1)], shield),
    (error: unknown) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
  const changedLifecycle = structuredClone(sources[3]!.lifecycleEvidence.start.document) as Record<string, unknown>
  changedLifecycle.startedAtUtc = "2026-09-09T11:15:24.628Z"
  const invalidLifecycle: AdvantageDatasetSource = {
    ...sources[3]!,
    lifecycleEvidence: {
      ...sources[3]!.lifecycleEvidence,
      start: { ...sources[3]!.lifecycleEvidence.start, document: changedLifecycle },
    },
  }
  await assert.rejects(
    buildAgentAdvantageReport([...sources.slice(0, 3), invalidLifecycle], shield),
    (error: unknown) => error instanceof AdvantageReportError && error.code === "LIFECYCLE_EVIDENCE",
  )
})

test("tampered Shield source evidence fails before report rendering", async () => {
  const shield = await loadShield()
  const rawOutputTexts = new Map(shield.rawOutputTexts)
  const firstPath = rawOutputTexts.keys().next().value
  if (firstPath === undefined) throw new Error("Shield raw evidence is empty")
  rawOutputTexts.set(firstPath, `${rawOutputTexts.get(firstPath)} `)
  await assert.rejects(
    buildAgentAdvantageReport(await loadSources(), { ...shield, rawOutputTexts }),
    (error: unknown) => error instanceof ShieldMeasurementError && error.code === "PUBLISHED_EVIDENCE_MISMATCH",
  )
})

async function loadSources(): Promise<AdvantageDatasetSource[]> {
  return Promise.all(datasetConfigs.map(async (config) => {
    const absolutePath = resolve(config.datasetPath)
    return {
      repositoryPath: config.datasetPath,
      dataset: JSON.parse(await readFile(absolutePath, "utf8")) as unknown,
      resolveEvidence: async (reference) => readFile(resolve(dirname(absolutePath), reference.uri)),
      lifecycleEvidence: {
        start: {
          repositoryPath: config.startPath,
          document: JSON.parse(await readFile(config.startPath, "utf8")) as unknown,
          valuePath: config.startValuePath,
        },
        end: {
          repositoryPath: config.endPath,
          document: JSON.parse(await readFile(config.endPath, "utf8")) as unknown,
          valuePath: config.endValuePath,
        },
      },
    }
  }))
}

async function loadShield(): Promise<ShieldReportSource> {
  const captureText = await readFile("evidence/shield/corpus-v1/raw/capture.json", "utf8")
  const captureInput: unknown = JSON.parse(captureText)
  const capture = shieldSlitherCapture.parse(captureInput)
  const rawOutputTexts = new Map<string, string>()
  for (const output of capture.outputs) rawOutputTexts.set(output.path, await readFile(output.path, "utf8"))
  return {
    evaluationPath: "evidence/shield/corpus-v1/evaluation.json",
    captureText,
    validationText: await readFile("evidence/shield/corpus-v1/manual-validation.json", "utf8"),
    rawOutputTexts,
    runsText: await readFile("evidence/shield/corpus-v1/runs.json", "utf8"),
    evaluation: JSON.parse(await readFile("evidence/shield/corpus-v1/evaluation.json", "utf8")) as unknown,
    groundTruthText: await readFile("tests/fixtures/shield/corpus-v1/ground-truth.json", "utf8"),
  }
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}
