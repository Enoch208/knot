import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  evaluateShieldDataset,
  hashShieldArtifact,
  shieldArtifact,
  shieldEvaluationRuns,
  shieldGroundTruthDataset,
  ShieldEvaluationError,
  type ShieldArtifact,
  type ShieldEvaluationRuns,
  type ShieldGroundTruthDataset,
} from "../../../packages/services/shield/index.ts"

const TARGET = "0x1111111111111111111111111111111111111111"
const HASHES = Array.from({ length: 6 }, (_, index) => `0x${(index + 1).toString(16).repeat(64)}`)

function dataset(): ShieldGroundTruthDataset {
  return shieldGroundTruthDataset.parse({
    schemaVersion: "knot.shield.ground-truth/1",
    datasetId: "shield-fixtures-v1",
    rulesFrozenAtUtc: "2026-09-09T08:00:00.000Z",
    groundTruthFrozenAtUtc: "2026-09-09T09:00:00.000Z",
    adjudication: {
      policyVersion: "shield-match-v1",
      assessorRelationship: "fixtures are team-owned and assessor is a team member",
      matchingRule: "rule+category+address+location+preconditions",
    },
    fixtures: HASHES.map((sourceBundleHash, index) => ({
      fixtureId: `fixture-${index + 1}`,
      role: index === 5 ? "holdout" : "development",
      sourceBundleHash,
      sourceLicense: "MIT",
      targetAddress: TARGET,
      expectedFindings: [{
        truthId: `truth-${index + 1}`,
        ruleId: "REENTRANCY_EXTERNAL_CALL",
        category: "VULNERABILITY",
        affectedAddress: TARGET,
        sourceLocation: `Fixture${index + 1}.sol:10-20`,
        requiredPreconditions: ["recipient can reenter before accounting is updated"],
        allowedSeverities: ["high", "critical"],
        criticalCase: index === 1,
      }],
      negativeControls: index === 3
        ? [{
          ruleId: "OWNER_PAUSE",
          category: "PRIVILEGED_CAPABILITY",
          affectedAddress: TARGET,
          sourceLocation: "Fixture4.sol:30-35",
          reason: "pause is permanently disabled in this fixture",
        }]
        : [],
    })),
  })
}

function finding(location: string, severity: ShieldArtifact["findings"][number]["severity"] = "high"): ShieldArtifact["findings"][number] {
  return {
    ruleId: "REENTRANCY_EXTERNAL_CALL",
    title: "External value transfer precedes accounting",
    category: "VULNERABILITY",
    severity,
    severityRationale: "the frozen control flow permits repeat withdrawal",
    confidence: "medium",
    affectedAddress: TARGET,
    affectedFunction: null,
    sourceLocation: location,
    evidence: [{ kind: "static_analyzer", reference: `slither@0.11.3:${location}`, contentHash: null }],
    preconditions: ["recipient can reenter before accounting is updated"],
    potentialConsequence: "assets may be withdrawn more than once",
    mitigation: "update accounting before the external call",
    validationMethod: "manual frozen-source control-flow review",
  }
}

function negativeControlFinding(): ShieldArtifact["findings"][number] {
  return {
    ruleId: "OWNER_PAUSE",
    title: "Owner can pause",
    category: "PRIVILEGED_CAPABILITY",
    severity: "informational",
    severityRationale: "privileged behavior is not exploitability",
    confidence: "high",
    affectedAddress: TARGET,
    affectedFunction: "pause()",
    sourceLocation: "Fixture4.sol:30-35",
    evidence: [{ kind: "verified_source", reference: "Fixture4.sol:30-35", contentHash: null }],
    preconditions: ["owner calls pause"],
    potentialConsequence: "operations stop",
    mitigation: "document the authority",
    validationMethod: "source review",
  }
}

function artifact(sourceBundleHash: string, findings: ShieldArtifact["findings"]): ShieldArtifact {
  return shieldArtifact.parse({
    schemaVersion: "knot.shield.artifact/1",
    category: "security",
    capability: "analysis",
    taskId: "shield-evaluation-task",
    status: "ASSESSED",
    reasonCode: null,
    assessedAtUtc: "2026-09-09T10:00:00.000Z",
    target: { chainId: 56, address: TARGET },
    snapshot: {
      blockNumber: "60000000",
      blockHash: `0x${"a".repeat(64)}`,
      sourceBundleHash,
    },
    proxy: { standard: "ERC-1967", implementation: null, admin: null, beacon: null },
    findings,
    negativeControls: [],
    unresolved: [],
    limitations: ["bounded fixture assessment only"],
  })
}

function runs(): ShieldEvaluationRuns {
  const artifacts = [
    artifact(HASHES[0]!, [finding("Fixture1.sol:10-20")]),
    artifact(HASHES[1]!, []),
    artifact(HASHES[2]!, [finding("Fixture3.sol:10-20", "medium")]),
    artifact(HASHES[3]!, [negativeControlFinding()]),
    artifact(HASHES[4]!, [finding("Fixture5.sol:10-20")]),
    artifact(HASHES[5]!, [finding("Fixture6.sol:10-20")]),
  ]
  return shieldEvaluationRuns.parse({
    schemaVersion: "knot.shield.runs/1",
    datasetId: "shield-fixtures-v1",
    runs: artifacts.map((item, index) => ({
      fixtureId: `fixture-${index + 1}`,
      artifactHash: hashShieldArtifact(item),
      artifact: item,
    })),
  })
}

describe("Shield frozen-fixture evaluation", () => {
  test("derives exact precision, recall, severity, and critical-miss counts from preserved artifacts", () => {
    const report = evaluateShieldDataset(dataset(), runs())
    assert.deepEqual(report.counts, {
      truePositives: 4,
      falsePositives: 1,
      falseNegatives: 2,
      criticalCaseMisses: 1,
      severityValid: 3,
      severityInvalid: 1,
      negativeControlViolations: 1,
    })
    assert.deepEqual(report.precision, { numerator: 4, denominator: 5, decimal: "0.800000" })
    assert.deepEqual(report.recall, { numerator: 4, denominator: 6, decimal: "0.666667" })
    assert.deepEqual(report.severityValidity, { numerator: 3, denominator: 4, decimal: "0.750000" })
    assert.equal(report.completedFixtureCount, 6)
    assert.equal(report.holdoutFixtureCount, 1)
    assert.match(report.limitations.join(" "), /do not establish comprehensive audit coverage/)
  })

  test("refuses incomplete runs rather than calculating flattering partial metrics", () => {
    const incomplete = runs()
    incomplete.runs.pop()
    assert.throws(
      () => evaluateShieldDataset(dataset(), incomplete),
      (error: unknown) => error instanceof ShieldEvaluationError && error.code === "INCOMPLETE_RUNS",
    )
  })

  test("refuses a changed artifact even when its fixture ID is unchanged", () => {
    const changed = runs()
    changed.runs[0]!.artifact.findings = []
    assert.throws(
      () => evaluateShieldDataset(dataset(), changed),
      (error: unknown) => error instanceof ShieldEvaluationError && error.code === "EVIDENCE_MISMATCH",
    )
  })

  test("refuses source-hash drift between a run and frozen ground truth", () => {
    const changed = runs()
    const run = changed.runs[0]!
    run.artifact.snapshot.sourceBundleHash = `0x${"f".repeat(64)}`
    run.artifactHash = hashShieldArtifact(run.artifact)
    assert.throws(
      () => evaluateShieldDataset(dataset(), changed),
      (error: unknown) => error instanceof ShieldEvaluationError && error.code === "EVIDENCE_MISMATCH",
    )
  })

  test("requires six fixtures and a holdout before accepting ground truth", () => {
    const tooSmall = { ...dataset(), fixtures: dataset().fixtures.slice(0, 5) }
    assert.equal(shieldGroundTruthDataset.safeParse(tooSmall).success, false)

    const noHoldout = dataset()
    noHoldout.fixtures.forEach((item) => { item.role = "development" })
    assert.equal(shieldGroundTruthDataset.safeParse(noHoldout).success, false)
  })
})
