import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, test } from "node:test"
import {
  ShieldCorpusError,
  shieldGroundTruthDataset,
  verifyShieldCorpus,
} from "../../../packages/services/shield/index.ts"

const ROOT = resolve("tests/fixtures/shield/corpus-v1")

function corpusInputs(): {
  groundTruth: unknown
  rulesText: string
  sources: Map<string, string>
} {
  const groundTruth: unknown = JSON.parse(readFileSync(resolve(ROOT, "ground-truth.json"), "utf8"))
  const parsed = shieldGroundTruthDataset.parse(groundTruth)
  const sources = new Map(
    parsed.fixtures.flatMap((fixture) => fixture.sourceFiles).map((source) => [
      source.path,
      readFileSync(resolve(ROOT, source.path), "utf8"),
    ]),
  )
  return {
    groundTruth,
    rulesText: readFileSync(resolve(ROOT, "rules.json"), "utf8"),
    sources,
  }
}

describe("Shield frozen corpus", () => {
  test("verifies six exact team-owned sources against frozen rules", () => {
    const inputs = corpusInputs()
    const verification = verifyShieldCorpus(inputs.groundTruth, inputs.rulesText, inputs.sources)
    assert.equal(verification.datasetId, "knot-shield-team-corpus-v1")
    assert.equal(verification.fixtureCount, 6)
    assert.equal(verification.developmentFixtureCount, 5)
    assert.equal(verification.holdoutFixtureCount, 1)
    assert.equal(verification.sourceFileCount, 6)
    assert.equal(verification.rulesContentHash, "0x7b67420c060ac95aebcc83fdc1e33ef2b952c8c69e4344091fbccbd93205455e")
    assert.deepEqual(Object.keys(verification.sourceBundleHashes), [
      "reentrant-vault",
      "unchecked-payout",
      "delegate-router",
      "owner-controls",
      "safe-vault",
      "transparent-proxy-holdout",
    ])
  })

  test("covers seeded defects, privilege controls, benign controls, and ERC-1967", () => {
    const inputs = corpusInputs()
    const dataset = shieldGroundTruthDataset.parse(inputs.groundTruth)
    const ruleIds = new Set(dataset.fixtures.flatMap((fixture) => fixture.expectedFindings.map((finding) => finding.ruleId)))
    const negativeRuleIds = new Set(dataset.fixtures.flatMap((fixture) => fixture.negativeControls.map((control) => control.ruleId)))
    const proxy = dataset.fixtures.find((fixture) => fixture.fixtureId === "transparent-proxy-holdout")
    const safe = dataset.fixtures.find((fixture) => fixture.fixtureId === "safe-vault")

    assert.ok(ruleIds.has("REENTRANCY_EXTERNAL_CALL"))
    assert.ok(ruleIds.has("UNCHECKED_LOW_LEVEL_CALL"))
    assert.ok(ruleIds.has("CONTROLLED_DELEGATECALL"))
    assert.ok(ruleIds.has("OWNER_MINT"))
    assert.ok(ruleIds.has("OWNER_PAUSE"))
    assert.ok(ruleIds.has("UPGRADE_AUTHORITY"))
    assert.ok(ruleIds.has("ERC1967_ADMIN"))
    assert.ok(negativeRuleIds.has("REENTRANCY_EXTERNAL_CALL"))
    assert.ok(negativeRuleIds.has("UNCHECKED_LOW_LEVEL_CALL"))
    assert.ok(negativeRuleIds.has("ERC1967_BEACON"))
    assert.equal(safe?.expectedFindings.length, 0)
    assert.equal(proxy?.role, "holdout")
    assert.ok(proxy?.sourceFiles.some((source) => source.path.endsWith("TransparentProxyHoldout.sol")))
    assert.ok(dataset.fixtures.every((fixture) => fixture.relationship === "team-owned" && fixture.sourceLicense === "MIT"))
    assert.match(dataset.adjudication.assessorRelationship, /team-owned/)
  })

  test("proves the holdout source was created after the rules freeze", () => {
    const inputs = corpusInputs()
    const dataset = shieldGroundTruthDataset.parse(inputs.groundTruth)
    const freeze = Date.parse(dataset.rulesFrozenAtUtc)
    const holdouts = dataset.fixtures.filter((fixture) => fixture.role === "holdout")
    const development = dataset.fixtures.filter((fixture) => fixture.role === "development")

    assert.equal(holdouts.length, 1)
    assert.ok(holdouts.every((fixture) => Date.parse(fixture.createdAtUtc) > freeze))
    assert.ok(development.every((fixture) => Date.parse(fixture.createdAtUtc) <= freeze))
    assert.ok(dataset.fixtures.every((fixture) => Date.parse(fixture.createdAtUtc) <= Date.parse(dataset.groundTruthFrozenAtUtc)))
  })

  test("rejects source drift before evaluation", () => {
    const inputs = corpusInputs()
    inputs.sources.set("contracts/ReentrantVault.sol", `${inputs.sources.get("contracts/ReentrantVault.sol")}\n`)
    assert.throws(
      () => verifyShieldCorpus(inputs.groundTruth, inputs.rulesText, inputs.sources),
      (error: unknown) => error instanceof ShieldCorpusError && error.code === "SOURCE_HASH_MISMATCH",
    )
  })

  test("rejects ground-truth labels outside the frozen rules", () => {
    const inputs = corpusInputs()
    const changed = shieldGroundTruthDataset.parse(inputs.groundTruth)
    changed.fixtures[0]!.expectedFindings[0]!.category = "CONFIGURATION_RISK"
    assert.throws(
      () => verifyShieldCorpus(changed, inputs.rulesText, inputs.sources),
      (error: unknown) => error instanceof ShieldCorpusError && error.code === "GROUND_TRUTH_MISMATCH",
    )
  })
})
