import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { summarise, type DirectoryEntry, type DirectorySnapshot } from "../../scripts/build-directory-snapshot.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SNAPSHOT = join(ROOT, "apps", "web", "src", "directory.snapshot.json")

const readSnapshot = async (): Promise<DirectorySnapshot> =>
  JSON.parse(await readFile(SNAPSHOT, "utf8")) as DirectorySnapshot

test("the published aggregates are derived from the published entries", async () => {
  const snapshot = await readSnapshot()
  assert.deepEqual(
    snapshot.aggregates,
    summarise(snapshot.entries),
    "run `npm run directory:snapshot` — the published aggregates disagree with the sampled entries",
  )
})

test("the sample never claims to be the whole registry", async () => {
  const snapshot = await readSnapshot()
  assert.ok(snapshot.sampleSize < snapshot.registeredTotal)
  assert.equal(snapshot.sampleSize, snapshot.entries.length)
  assert.match(snapshot.coverageStatement, /not an enumeration/)
  assert.match(snapshot.coverageStatement, /has not called, validated, or hired/)
})

test("no aggregate can exceed the sample it was drawn from", async () => {
  const snapshot = await readSnapshot()
  for (const [name, value] of Object.entries(snapshot.aggregates)) {
    assert.ok(
      value <= snapshot.sampleSize,
      `${name} reports ${value} across a sample of ${snapshot.sampleSize}`,
    )
  }
})

test("an unscored agent is published as unavailable rather than zero", async () => {
  const snapshot = await readSnapshot()
  for (const entry of snapshot.entries) {
    if (entry.averageScore === null) continue
    assert.ok(entry.feedbackCount !== null && entry.feedbackCount > 0, `${entry.agentId} carries a score with no feedback behind it`)
  }
})

test("registry metadata is never presented as verified", async () => {
  const snapshot = await readSnapshot()
  for (const entry of snapshot.entries) {
    if (entry.knotVerified) continue
    assert.equal(
      entry.nameProvenance,
      "CLAIMED",
      `${entry.agentId} publishes a name as ${entry.nameProvenance} without KNOT verification`,
    )
  }
})

test("summarise counts a default scaffold name only on an exact match", () => {
  const entry = (name: string): DirectoryEntry => ({
    agentId: "1",
    registry: "0x8004",
    chainId: 97,
    ownerAddress: "0xabc",
    name,
    nameProvenance: "CLAIMED",
    description: "",
    indexVerified: false,
    feedbackCount: 0,
    averageScore: null,
    averageScoreProvenance: "UNAVAILABLE",
    knotVerified: false,
  })
  const result = summarise([entry("studio-agent"), entry("studio-agent-two"), entry("Studio-Agent")])
  assert.equal(result.defaultScaffoldNames, 2)
  assert.equal(result.withAnyScore, 0)
})
