import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { keccak256, stringToHex } from "viem"
import { shieldSlitherOutput } from "../packages/services/shield/index.ts"

const fixtures = [
  ["reentrant-vault", "ReentrantVault.sol"],
  ["unchecked-payout", "UncheckedPayout.sol"],
  ["delegate-router", "DelegateRouter.sol"],
  ["owner-controls", "OwnerControls.sol"],
  ["safe-vault", "SafeVault.sol"],
  ["transparent-proxy-holdout", "TransparentProxyHoldout.sol"],
] as const

const slither = process.env.SHIELD_SLITHER_BIN
const solc = process.env.SHIELD_SOLC_BIN
assert.ok(slither, "SHIELD_SLITHER_BIN is required")
assert.ok(solc, "SHIELD_SOLC_BIN is required")

const corpusRoot = resolve("tests/fixtures/shield/corpus-v1")
const outputRoot = resolve("evidence/shield/corpus-v1/raw")
const temporaryRoot = mkdtempSync(join(tmpdir(), "knot-shield-slither-"))
const slitherVersion = spawnSync(slither, ["--version"], { encoding: "utf8" })
const solcVersion = spawnSync(solc, ["--version"], { encoding: "utf8" })
assert.equal(slitherVersion.status, 0)
assert.equal(slitherVersion.stdout.trim(), "0.11.3")
assert.equal(solcVersion.status, 0)
assert.match(solcVersion.stdout, /Version: 0\.8\.28\+/)
mkdirSync(outputRoot, { recursive: true })

const outputs: Array<{
  fixtureId: string
  path: string
  contentHash: `0x${string}`
  detectorCount: number
  processExitStatus: number | null
}> = []

try {
  for (const [fixtureId, sourceName] of fixtures) {
    const temporaryOutput = join(temporaryRoot, `${fixtureId}.json`)
    const result = spawnSync(slither, [
      `contracts/${sourceName}`,
      "--solc",
      solc,
      "--solc-args",
      "--evm-version paris --optimize --optimize-runs 200",
      "--json",
      temporaryOutput,
    ], { cwd: corpusRoot, encoding: "utf8" })
    const input: unknown = JSON.parse(readFileSync(temporaryOutput, "utf8"))
    const parsed = shieldSlitherOutput.parse(input)
    const normalized = normalizePaths(parsed, corpusRoot)
    const text = `${JSON.stringify(normalized, null, 2)}\n`
    const path = `evidence/shield/corpus-v1/raw/${fixtureId}.json`
    writeFileSync(resolve(path), text)
    outputs.push({
      fixtureId,
      path,
      contentHash: keccak256(stringToHex(text)),
      detectorCount: parsed.results.detectors.length,
      processExitStatus: result.status,
    })
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

const capture = {
  schemaVersion: "knot.shield.slither-capture/1",
  analyzer: { name: "slither", version: "0.11.3", detectorCount: 100 },
  compiler: { name: "solc", version: "0.8.28", optimizerEnabled: true, optimizerRuns: 200, evmVersion: "paris" },
  commandTemplate: "slither contracts/<fixture>.sol --solc <solc-0.8.28> --solc-args '--evm-version paris --optimize --optimize-runs 200' --json <output>",
  pathNormalization: "filename_absolute values under the corpus root are replaced with $CORPUS_ROOT/<relative-path>",
  outputs,
}
writeFileSync(resolve(outputRoot, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`)

function normalizePaths(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizePaths(item, root))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "filename_absolute" && typeof item === "string") {
      const path = relative(root, item)
      assert.equal(path.startsWith(".."), false)
      return [key, `$CORPUS_ROOT/${path}`]
    }
    return [key, normalizePaths(item, root)]
  }))
}
