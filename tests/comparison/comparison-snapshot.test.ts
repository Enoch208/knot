import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  buildSnapshot,
  readExternalCandidates,
  type ComparisonSnapshot,
} from "../../scripts/build-comparison-snapshot.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SNAPSHOT = join(ROOT, "apps", "web", "src", "comparison.snapshot.json")

const readSnapshot = async (): Promise<ComparisonSnapshot> =>
  JSON.parse(await readFile(SNAPSHOT, "utf8")) as ComparisonSnapshot

test("the published comparison matches what the engine derives from evidence", async () => {
  const published = await readSnapshot()
  const { candidates, latestObservationUtc } = await readExternalCandidates()
  const derived = buildSnapshot(candidates, latestObservationUtc)
  assert.deepEqual(
    published,
    derived,
    "run `npm run comparison:snapshot` — the published comparison has drifted from evidence/testnet",
  )
})

test("every external candidate carries the price actually recorded on its paid job", async () => {
  const { candidates } = await readExternalCandidates()
  assert.ok(candidates.length > 0, "no external candidates were read")
  for (const candidate of candidates) {
    assert.equal(candidate.operatorRelationship, "EXTERNAL_DISTINCT_OWNER")
    assert.match(candidate.priceBaseUnits ?? "", /^[0-9]+$/)
    assert.match(candidate.currency ?? "", /^0x[0-9a-fA-F]{40}$/)
  }
})

test("no external candidate is recorded as having delivered", async () => {
  const { candidates } = await readExternalCandidates()
  for (const candidate of candidates) {
    assert.equal(
      candidate.completedJobs,
      0,
      `${candidate.displayName} is published as having delivered; evidence/testnet records otherwise`,
    )
  }
})

test("a recommendation is never asserted without a decisive dimension", async () => {
  const snapshot = await readSnapshot()
  for (const category of snapshot.categories) {
    const { outcome, recommendedKey, decisiveDimension } = category.comparison
    if (recommendedKey !== null && outcome !== "SINGLE_CANDIDATE") {
      assert.equal(
        decisiveDimension,
        "price",
        `${category.key} recommends a candidate without naming the dimension that separated them`,
      )
    }
    if (outcome === "TIE") {
      assert.equal(recommendedKey, null, `${category.key} reports a tie yet recommends a candidate`)
    }
  }
})

test("every ranked category discloses what price does not measure", async () => {
  const snapshot = await readSnapshot()
  for (const category of snapshot.categories) {
    if (category.comparison.outcome !== "DECIDED") continue
    assert.ok(
      category.comparison.limitations.some((line) => /does not measure delivered quality/.test(line)),
      `${category.key} ranks on price without disclosing the limit of that ranking`,
    )
  }
})

test("a category containing an independent owner is never labelled same-operator", async () => {
  const snapshot = await readSnapshot()
  for (const category of snapshot.categories) {
    const hasExternal = category.comparison.rows.some(
      (row) => row.eligible && row.operatorRelationship === "EXTERNAL_DISTINCT_OWNER",
    )
    if (!hasExternal) continue
    assert.notEqual(
      category.comparison.operatorIndependence,
      "SAME_OPERATOR",
      `${category.key} contains an independently operated candidate but claims a single operator`,
    )
  }
})
