import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  shieldGroundTruthDataset,
  shieldSlitherCapture,
  verifyPublishedShieldMeasurement,
  verifyShieldCorpus,
} from "../packages/services/shield/index.ts"

const corpusRoot = resolve("tests/fixtures/shield/corpus-v1")
const evidenceRoot = resolve("evidence/shield/corpus-v1")
const groundTruthText = readFileSync(resolve(corpusRoot, "ground-truth.json"), "utf8")
const groundTruthInput: unknown = JSON.parse(groundTruthText)
const groundTruth = shieldGroundTruthDataset.parse(groundTruthInput)
const rulesText = readFileSync(resolve(corpusRoot, "rules.json"), "utf8")
const declaredPaths = groundTruth.fixtures.flatMap((fixture) => fixture.sourceFiles.map((source) => source.path)).sort()
const diskPaths = readdirSync(resolve(corpusRoot, "contracts"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sol"))
  .map((entry) => `contracts/${entry.name}`)
  .sort()
if (JSON.stringify(declaredPaths) !== JSON.stringify(diskPaths)) throw new Error("frozen Shield source set changed")
const sourceContents = new Map(declaredPaths.map((path) => [path, readFileSync(resolve(corpusRoot, path), "utf8")]))
const corpus = verifyShieldCorpus(groundTruth, rulesText, sourceContents)
const compilation = spawnSync("forge", ["build", "--root", corpusRoot], { encoding: "utf8" })
if (compilation.error) throw compilation.error
if (compilation.status !== 0) {
  process.stderr.write(compilation.stderr)
  process.stderr.write(compilation.stdout)
  process.exit(compilation.status ?? 1)
}

const captureText = readFileSync(resolve(evidenceRoot, "raw/capture.json"), "utf8")
const captureInput: unknown = JSON.parse(captureText)
const capture = shieldSlitherCapture.parse(captureInput)
const rawOutputTexts = new Map(capture.outputs.map((output) => [output.path, readFileSync(resolve(output.path), "utf8")]))
const report = verifyPublishedShieldMeasurement({
  captureText,
  validationText: readFileSync(resolve(evidenceRoot, "manual-validation.json"), "utf8"),
  rawOutputTexts,
  runsText: readFileSync(resolve(evidenceRoot, "runs.json"), "utf8"),
  evaluation: JSON.parse(readFileSync(resolve(evidenceRoot, "evaluation.json"), "utf8")) as unknown,
  groundTruthText,
})

process.stdout.write(`${JSON.stringify({
  status: "MEASURED",
  corpus,
  compilation: { status: "passed", compiler: groundTruth.compiler },
  rawSignalCount: capture.outputs.reduce((sum, output) => sum + output.detectorCount, 0),
  report,
}, null, 2)}\n`)
