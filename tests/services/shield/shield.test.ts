import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  analyzeShield,
  analyzeShieldText,
  shieldArtifact,
  shieldRequest,
  type ShieldRequest,
} from "../../../packages/services/shield/index.ts"

const NOW = new Date("2026-09-09T12:00:00.000Z")
const TARGET = "0x1111111111111111111111111111111111111111"
const ADMIN = "0x2222222222222222222222222222222222222222"
const IMPLEMENTATION = "0x3333333333333333333333333333333333333333"
const SOURCE_HASH = `0x${"a".repeat(64)}`
const BLOCK_HASH = `0x${"b".repeat(64)}`
const CODE_HASH = `0x${"c".repeat(64)}`
const emptySlot = { status: "empty" as const, value: null, rawValue: `0x${"0".repeat(64)}` as const }

function rawAddressSlot(value: string): `0x${string}` {
  return `0x${"0".repeat(24)}${value.slice(2)}`
}

function validRequest(): ShieldRequest {
  return shieldRequest.parse({
    schemaVersion: "knot.shield.request/1",
    taskId: "shield-task-1",
    target: { chainId: 56, address: TARGET },
    maxSnapshotAgeSeconds: 300,
    requestedChecks: ["source_availability", "erc1967_proxy_slots", "verified_privileges", "static_analysis"],
    snapshot: {
      schemaVersion: "knot.shield.snapshot/1",
      targetAddress: TARGET,
      chainId: 56,
      blockNumber: "60000000",
      blockHash: BLOCK_HASH,
      blockTimestampUtc: "2026-09-09T11:59:20.000Z",
      capturedAtUtc: "2026-09-09T11:59:30.000Z",
      canonicality: "confirmed",
      runtimeBytecode: { status: "available", codeHash: CODE_HASH, sizeBytes: 1024 },
      verifiedSource: {
        status: "available",
        compiler: "solc 0.8.28",
        sourceBundleUri: "https://example.invalid/source-bundle.json",
        sourceBundleHash: SOURCE_HASH,
        license: "MIT",
      },
      proxySlots: {
        implementation: { status: "value", value: IMPLEMENTATION, rawValue: rawAddressSlot(IMPLEMENTATION) },
        admin: { status: "value", value: ADMIN, rawValue: rawAddressSlot(ADMIN) },
        beacon: emptySlot,
      },
      observations: [
        {
          kind: "verified_privilege",
          ruleId: "OWNER_MINT",
          title: "Owner can mint supply",
          functionSignature: "mint(address,uint256)",
          affectedAddress: IMPLEMENTATION,
          sourceBundleHash: SOURCE_HASH,
          sourceLocation: "Token.sol:44-51",
          accessControl: "onlyOwner must authorize the external caller",
          externalReachabilityConfirmed: true,
          consequence: "the owner can increase circulating supply",
          mitigation: "disclose ownership and place mint authority behind reviewed governance controls",
        },
        {
          kind: "static_analyzer",
          ruleId: "REENTRANCY_EXTERNAL_CALL",
          title: "External value transfer precedes accounting update",
          affectedAddress: IMPLEMENTATION,
          sourceBundleHash: SOURCE_HASH,
          sourceLocation: "Vault.sol:73-81",
          analyzer: "slither",
          analyzerVersion: "0.11.3",
          validation: "confirmed",
          severity: "high",
          severityRationale: "a caller-controlled reentry can repeat withdrawal before the balance update",
          preconditions: ["the recipient is a contract capable of reentry"],
          consequence: "assets may be withdrawn more than once",
          mitigation: "update accounting before the external call and add a reentrancy guard",
          validationMethod: "manual control-flow review against the frozen verified source",
        },
        {
          kind: "static_analyzer",
          ruleId: "UNCHECKED_LOW_LEVEL_CALL",
          title: "Analyzer candidate rejected by source review",
          affectedAddress: IMPLEMENTATION,
          sourceBundleHash: SOURCE_HASH,
          sourceLocation: "Relay.sol:20-22",
          analyzer: "slither",
          analyzerVersion: "0.11.3",
          validation: "rejected",
          severity: "medium",
          severityRationale: "the raw analyzer signal would matter only if the return value were ignored",
          preconditions: ["the low-level call returns false"],
          consequence: "state could diverge from external execution",
          mitigation: "continue checking the returned status",
          validationMethod: "the frozen source checks success and reverts on false",
        },
      ],
    },
  })
}

describe("Shield bounded contract-risk triage", () => {
  test("reports validated vulnerability and privilege evidence without a synthetic score", () => {
    const result = analyzeShield(validRequest(), NOW)
    assert.equal(result.status, "ASSESSED")
    assert.equal(result.proxy.implementation, IMPLEMENTATION)
    assert.equal(result.proxy.admin, ADMIN)
    assert.equal(result.findings.length, 3)
    const mint = result.findings.find((finding) => finding.ruleId === "OWNER_MINT")
    const reentrancy = result.findings.find((finding) => finding.ruleId === "REENTRANCY_EXTERNAL_CALL")
    const proxyAdmin = result.findings.find((finding) => finding.ruleId === "ERC1967_ADMIN")
    assert.equal(mint?.category, "PRIVILEGED_CAPABILITY")
    assert.equal(mint?.severity, "informational")
    assert.equal(reentrancy?.category, "VULNERABILITY")
    assert.equal(reentrancy?.severity, "high")
    assert.equal(proxyAdmin?.category, "PRIVILEGED_CAPABILITY")
    assert.deepEqual(result.negativeControls, [{
      ruleId: "UNCHECKED_LOW_LEVEL_CALL",
      reason: "the frozen source checks success and reverts on false",
    }])
    assert.equal("score" in result, false)
    assert.equal(shieldArtifact.safeParse(result).success, true)
  })

  test("keeps an unvalidated analyzer signal unresolved instead of calling it a vulnerability", () => {
    const request = validRequest()
    const observation = request.snapshot.observations.find((item) => item.kind === "static_analyzer" && item.validation === "confirmed")
    assert.ok(observation?.kind === "static_analyzer")
    observation.validation = "unresolved"
    observation.validationMethod = "the external call target cannot be resolved from the frozen source"
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.findings.some((finding) => finding.ruleId === "REENTRANCY_EXTERNAL_CALL"), false)
    assert.match(result.unresolved.map((item) => item.reason).join(" "), /cannot be resolved/)
  })

  test("does not attribute observations from a different source bundle", () => {
    const request = validRequest()
    const observation = request.snapshot.observations[0]
    assert.ok(observation)
    observation.sourceBundleHash = `0x${"d".repeat(64)}`
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.findings.some((finding) => finding.ruleId === "OWNER_MINT"), false)
    assert.match(result.unresolved.map((item) => item.reason).join(" "), /does not match/)
  })

  test("treats empty ERC-1967 slots as unresolved rather than proof of immutability", () => {
    const request = validRequest()
    request.snapshot.proxySlots.implementation = emptySlot
    request.snapshot.proxySlots.admin = emptySlot
    request.snapshot.observations = []
    request.requestedChecks = ["erc1967_proxy_slots"]
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.findings.length, 0)
    assert.match(result.unresolved[0]?.reason ?? "", /slots are empty/)
    assert.match(result.limitations.join(" "), /non-standard proxy/)
  })

  test("reports unavailable verified source and missing check coverage", () => {
    const request = validRequest()
    request.snapshot.verifiedSource = { status: "unavailable", reason: "the explorer has no verified source" }
    request.snapshot.observations = []
    request.requestedChecks = ["source_availability", "verified_privileges", "static_analysis"]
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "PARTIAL")
    assert.match(result.unresolved.map((item) => item.reason).join(" "), /no verified source/)
    assert.match(result.unresolved.map((item) => item.reason).join(" "), /supplied no observations/)
  })

  test("refuses a snapshot for a different target", () => {
    const request = validRequest()
    request.snapshot.targetAddress = "0x4444444444444444444444444444444444444444"
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "REFUSED")
    assert.equal(result.reasonCode, "SNAPSHOT_TARGET_MISMATCH")
    assert.equal(result.findings.length, 0)
  })

  test("refuses unconfirmed, stale, and bytecode-unavailable snapshots", () => {
    const unconfirmed = validRequest()
    unconfirmed.snapshot.canonicality = "unconfirmed"
    assert.equal(analyzeShield(unconfirmed, NOW).reasonCode, "SNAPSHOT_NOT_CONFIRMED")

    const stale = validRequest()
    stale.snapshot.capturedAtUtc = "2026-09-09T11:00:00.000Z"
    assert.equal(analyzeShield(stale, NOW).reasonCode, "STALE_SNAPSHOT")

    const unavailable = validRequest()
    unavailable.snapshot.runtimeBytecode = { status: "unavailable", reason: "RPC returned no code" }
    assert.equal(analyzeShield(unavailable, NOW).reasonCode, "RUNTIME_BYTECODE_UNAVAILABLE")
  })

  test("rejects malformed JSON and unknown request fields through closed schemas", () => {
    const malformed = JSON.parse(analyzeShieldText("not-json", NOW)) as unknown
    assert.equal(shieldArtifact.parse(malformed).status, "INVALID_REQUEST")

    const request = validRequest() as ShieldRequest & { inventedSafetyScore?: number }
    request.inventedSafetyScore = 99
    const result = analyzeShield(request, NOW)
    assert.equal(result.status, "INVALID_REQUEST")
    assert.equal(result.reasonCode, "SCHEMA_VALIDATION_FAILED")
  })
})
