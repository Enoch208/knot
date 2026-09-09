import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  evaluateShieldDataset,
  shieldGroundTruthDataset,
  verifyShieldCorpus,
} from "../packages/services/shield/index.ts"

const corpusRoot = resolve("tests/fixtures/shield/corpus-v1")
const groundTruthPath = resolve(corpusRoot, "ground-truth.json")
const rulesPath = resolve(corpusRoot, "rules.json")
const groundTruthInput: unknown = JSON.parse(readFileSync(groundTruthPath, "utf8"))
const groundTruth = shieldGroundTruthDataset.parse(groundTruthInput)
const declaredPaths = groundTruth.fixtures.flatMap((fixture) => fixture.sourceFiles.map((source) => source.path)).sort()
const diskPaths = readdirSync(resolve(corpusRoot, "contracts"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sol"))
  .map((entry) => `contracts/${entry.name}`)
  .sort()

assert.deepEqual(diskPaths, declaredPaths, "compiled Solidity sources must exactly match the frozen corpus")

const sourceContents = new Map(declaredPaths.map((path) => [path, readFileSync(resolve(corpusRoot, path), "utf8")]))
const corpus = verifyShieldCorpus(groundTruth, readFileSync(rulesPath, "utf8"), sourceContents)
const compilation = spawnSync("forge", ["build", "--root", corpusRoot], { encoding: "utf8" })

if (compilation.error) throw compilation.error
if (compilation.status !== 0) {
  process.stderr.write(compilation.stderr)
  process.stderr.write(compilation.stdout)
  process.exitCode = compilation.status ?? 1
} else {
  const runsPath = process.argv[2]
  if (runsPath === undefined) {
    const analyzer = spawnSync("slither", ["--version"], { encoding: "utf8" })
    const result = {
      schemaVersion: "knot.shield.preparation/1",
      status: "UNMEASURED",
      corpus,
      compilation: {
        status: "passed",
        compiler: groundTruth.compiler,
      },
      analyzer: {
        name: "slither",
        availableInEnvironment: analyzer.status === 0,
        validatedRunProvided: false,
      },
      blocker: "No analyzer-produced and manually validated Shield artifact set was supplied; precision, recall, severity validity, and critical-miss rate are not measured.",
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const runsInput: unknown = JSON.parse(readFileSync(resolve(runsPath), "utf8"))
    const report = evaluateShieldDataset(groundTruth, runsInput)
    process.stdout.write(`${JSON.stringify({ status: "MEASURED", report }, null, 2)}\n`)
  }
}
