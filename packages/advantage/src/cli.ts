import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HealthGuardIndependentEvaluator } from "./healthguard.ts"
import { RangePilotIndependentEvaluator } from "./rangepilot.ts"
import { validateExperimentDataset, type EvidenceResolver } from "./runner.ts"
import { YieldScoutIndependentEvaluator } from "./yieldscout.ts"

const datasetArgument = process.argv[2]
if (!datasetArgument) throw new Error("usage: npm run advantage:verify -- <dataset.json>")

const datasetPath = resolve(datasetArgument)
const baseUrl = pathToFileURL(`${dirname(datasetPath)}/`)
const resolver: EvidenceResolver = async (reference) => {
  const url = new URL(reference.uri, baseUrl)
  if (url.protocol !== "file:") throw new Error(`unsupported evidence URI protocol: ${url.protocol}`)
  return readFile(fileURLToPath(url))
}

const source = await readFile(datasetPath, "utf8")
const dataset = await validateExperimentDataset(JSON.parse(source) as unknown, resolver, [
  new HealthGuardIndependentEvaluator(),
  new RangePilotIndependentEvaluator(),
  new YieldScoutIndependentEvaluator(),
])
console.info(`[advantage] verified ${dataset.experiments.length} paired experiment record(s)`)
