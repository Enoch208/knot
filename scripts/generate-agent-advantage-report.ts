import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { buildAgentAdvantageReport, type AdvantageDatasetSource } from "../packages/advantage/src/report.ts"
import type { HumanArmComparison } from "../packages/advantage/src/human-arm.ts"
import { shieldSlitherCapture } from "../packages/services/shield/index.ts"

const repositoryRoot = resolve(import.meta.dirname, "..")
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
const sources: AdvantageDatasetSource[] = await Promise.all(datasetConfigs.map(async (config) => {
  const absolutePath = resolve(repositoryRoot, config.datasetPath)
  const datasetText = await readFile(absolutePath, "utf8")
  return {
    repositoryPath: config.datasetPath,
    dataset: JSON.parse(datasetText) as unknown,
    resolveEvidence: async (reference) => readFile(resolve(dirname(absolutePath), reference.uri)),
    lifecycleEvidence: {
      start: {
        repositoryPath: config.startPath,
        document: JSON.parse(await readFile(resolve(repositoryRoot, config.startPath), "utf8")) as unknown,
        valuePath: config.startValuePath,
      },
      end: {
        repositoryPath: config.endPath,
        document: JSON.parse(await readFile(resolve(repositoryRoot, config.endPath), "utf8")) as unknown,
        valuePath: config.endValuePath,
      },
    },
  }
}))

const captureText = await readFile(resolve(repositoryRoot, "evidence/shield/corpus-v1/raw/capture.json"), "utf8")
const captureInput: unknown = JSON.parse(captureText)
const capture = shieldSlitherCapture.parse(captureInput)
const rawOutputTexts = new Map<string, string>()
for (const output of capture.outputs) {
  rawOutputTexts.set(output.path, await readFile(resolve(repositoryRoot, output.path), "utf8"))
}
const humanArmArtifact = JSON.parse(
  await readFile(resolve(repositoryRoot, "evidence/advantage/human-arm/yield-1188.json"), "utf8"),
) as { comparison: HumanArmComparison }

const report = await buildAgentAdvantageReport(sources, {
  evaluationPath: "evidence/shield/corpus-v1/evaluation.json",
  captureText,
  validationText: await readFile(resolve(repositoryRoot, "evidence/shield/corpus-v1/manual-validation.json"), "utf8"),
  rawOutputTexts,
  runsText: await readFile(resolve(repositoryRoot, "evidence/shield/corpus-v1/runs.json"), "utf8"),
  evaluation: JSON.parse(await readFile(resolve(repositoryRoot, "evidence/shield/corpus-v1/evaluation.json"), "utf8")) as unknown,
  groundTruthText: await readFile(resolve(repositoryRoot, "tests/fixtures/shield/corpus-v1/ground-truth.json"), "utf8"),
}, humanArmArtifact.comparison)
const outputPath = resolve(repositoryRoot, "docs/AGENT_ADVANTAGE_REPORT.md")
await writeFile(outputPath, report)
process.stdout.write(`[advantage] verified four finance pairs and Shield; wrote ${outputPath}\n`)
