import { shieldArtifact, shieldRequest, type ShieldArtifact, type ShieldFinding, type ShieldRequest } from "./schemas.ts"

const limitations = [
  "bounded triage only; this is not a comprehensive audit or a safe-to-use certificate",
  "no exploit transactions or state-changing calls are performed",
  "non-standard proxy mechanisms and behavior outside the supplied snapshot remain unknown",
]

export function analyzeShieldText(text: string, now = new Date()): string {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return JSON.stringify(refusal("INVALID_REQUEST", "INVALID_JSON", now, null))
  }
  return JSON.stringify(analyzeShield(input, now))
}

export function analyzeShield(input: unknown, now = new Date()): ShieldArtifact {
  const parsed = shieldRequest.safeParse(input)
  if (!parsed.success) return refusal("INVALID_REQUEST", "SCHEMA_VALIDATION_FAILED", now, null)
  const request = parsed.data
  if (request.target.address !== request.snapshot.targetAddress || request.target.chainId !== request.snapshot.chainId) {
    return refusal("REFUSED", "SNAPSHOT_TARGET_MISMATCH", now, request)
  }
  if (request.snapshot.canonicality !== "confirmed") return refusal("REFUSED", "SNAPSHOT_NOT_CONFIRMED", now, request)
  if (isStale(request.snapshot.capturedAtUtc, request.maxSnapshotAgeSeconds, now)) {
    return refusal("REFUSED", "STALE_SNAPSHOT", now, request)
  }
  if (request.snapshot.runtimeBytecode.status === "unavailable") {
    return refusal("REFUSED", "RUNTIME_BYTECODE_UNAVAILABLE", now, request)
  }

  const findings: ShieldFinding[] = []
  const negativeControls: ShieldArtifact["negativeControls"] = []
  const unresolved: ShieldArtifact["unresolved"] = []
  const proxy = request.snapshot.proxySlots

  if (request.requestedChecks.includes("erc1967_proxy_slots")) {
    addProxyEvidence(request, findings, unresolved)
  }

  if (request.requestedChecks.includes("source_availability") && request.snapshot.verifiedSource.status === "unavailable") {
    unresolved.push({
      check: "verified source availability",
      reason: request.snapshot.verifiedSource.reason,
      consequence: "source-level control flow and privilege findings cannot be established",
    })
  }

  const sourceHash = request.snapshot.verifiedSource.status === "available"
    ? request.snapshot.verifiedSource.sourceBundleHash
    : null
  for (const observation of request.snapshot.observations) {
    if (observation.kind === "verified_privilege") {
      if (!request.requestedChecks.includes("verified_privileges")) continue
      if (sourceHash === null || sourceHash !== observation.sourceBundleHash) {
        unresolved.push({
          check: observation.ruleId,
          reason: "observation source hash does not match the snapshot source bundle",
          consequence: "the claimed privileged capability is not reported as a finding",
        })
        continue
      }
      findings.push({
        ruleId: observation.ruleId,
        title: observation.title,
        category: "PRIVILEGED_CAPABILITY",
        severity: "informational",
        severityRationale: "the observation establishes privileged behavior, not exploitability",
        confidence: "high",
        affectedAddress: observation.affectedAddress,
        affectedFunction: observation.functionSignature,
        sourceLocation: observation.sourceLocation,
        evidence: [{ kind: "verified_source", reference: observation.sourceLocation, contentHash: sourceHash }],
        preconditions: [observation.accessControl],
        potentialConsequence: observation.consequence,
        mitigation: observation.mitigation,
        validationMethod: "verified source control flow with confirmed external reachability",
      })
      continue
    }
    if (!request.requestedChecks.includes("static_analysis")) continue
    if (sourceHash === null || sourceHash !== observation.sourceBundleHash) {
      unresolved.push({
        check: observation.ruleId,
        reason: "analyzer source hash does not match the snapshot source bundle",
        consequence: "the analyzer result cannot be attributed to this snapshot",
      })
      continue
    }
    if (observation.validation === "rejected") {
      negativeControls.push({ ruleId: observation.ruleId, reason: observation.validationMethod })
      continue
    }
    if (observation.validation === "unresolved") {
      unresolved.push({
        check: observation.ruleId,
        reason: observation.validationMethod,
        consequence: "the analyzer signal is not promoted to a vulnerability finding",
      })
      continue
    }
    findings.push({
      ruleId: observation.ruleId,
      title: observation.title,
      category: observation.ruleId === "CONTROLLED_DELEGATECALL" ? "CONFIGURATION_RISK" : "VULNERABILITY",
      severity: observation.severity,
      severityRationale: observation.severityRationale,
      confidence: "medium",
      affectedAddress: observation.affectedAddress,
      affectedFunction: null,
      sourceLocation: observation.sourceLocation,
      evidence: [{
        kind: "static_analyzer",
        reference: `${observation.analyzer}@${observation.analyzerVersion}:${observation.sourceLocation}`,
        contentHash: sourceHash,
      }],
      preconditions: observation.preconditions,
      potentialConsequence: observation.consequence,
      mitigation: observation.mitigation,
      validationMethod: observation.validationMethod,
    })
  }

  const missingRequestedObservation = request.requestedChecks.some((check) => {
    if (check === "verified_privileges") return request.snapshot.observations.every((item) => item.kind !== "verified_privilege")
    if (check === "static_analysis") return request.snapshot.observations.every((item) => item.kind !== "static_analyzer")
    return false
  })
  if (missingRequestedObservation) {
    unresolved.push({
      check: "requested observation coverage",
      reason: "one or more requested evidence-producing checks supplied no observations",
      consequence: "absence of a finding does not establish absence of the underlying risk",
    })
  }

  return shieldArtifact.parse({
    schemaVersion: "knot.shield.artifact/1",
    category: "security",
    capability: "analysis",
    taskId: request.taskId,
    status: unresolved.length === 0 ? "ASSESSED" : "PARTIAL",
    reasonCode: unresolved.length === 0 ? null : "UNRESOLVED_CHECKS",
    assessedAtUtc: now.toISOString(),
    target: request.target,
    snapshot: {
      blockNumber: request.snapshot.blockNumber,
      blockHash: request.snapshot.blockHash,
      sourceBundleHash: sourceHash,
    },
    proxy: {
      standard: "ERC-1967",
      implementation: proxy.implementation.status === "value" ? proxy.implementation.value : null,
      admin: proxy.admin.status === "value" ? proxy.admin.value : null,
      beacon: proxy.beacon.status === "value" ? proxy.beacon.value : null,
    },
    findings,
    negativeControls,
    unresolved,
    limitations,
  })
}

function addProxyEvidence(
  request: ShieldRequest,
  findings: ShieldFinding[],
  unresolved: ShieldArtifact["unresolved"],
): void {
  const { proxySlots, blockNumber } = request.snapshot
  for (const [slotName, observation] of Object.entries(proxySlots)) {
    if (observation.status === "unreadable") {
      unresolved.push({
        check: `ERC-1967 ${slotName} slot`,
        reason: observation.reason,
        consequence: "standard proxy state could not be established",
      })
    }
  }
  if (proxySlots.implementation.status === "empty" && proxySlots.beacon.status === "empty") {
    unresolved.push({
      check: "upgradeability outside ERC-1967",
      reason: "standard implementation and beacon slots are empty",
      consequence: "non-standard upgrade mechanisms are not ruled out",
    })
  }
  if (proxySlots.admin.status === "value") {
    findings.push({
      ruleId: "ERC1967_ADMIN",
      title: "ERC-1967 admin is configured",
      category: "PRIVILEGED_CAPABILITY",
      severity: "informational",
      severityRationale: "an admin slot demonstrates authority but does not by itself demonstrate an exploit",
      confidence: "high",
      affectedAddress: request.target.address,
      affectedFunction: null,
      sourceLocation: null,
      evidence: [{
        kind: "storage_slot",
        reference: `erc1967.admin@${blockNumber}`,
        contentHash: request.snapshot.blockHash,
      }],
      preconditions: ["the configured admin controls a supported proxy administration path"],
      potentialConsequence: "the administrator may be able to change proxy behavior",
      mitigation: "document the administrator, access policy, delay, and monitoring controls",
      validationMethod: "read the ERC-1967 admin storage slot at the pinned block",
    })
  }
  if (proxySlots.beacon.status === "value") {
    findings.push({
      ruleId: "ERC1967_BEACON",
      title: "ERC-1967 beacon is configured",
      category: "CONFIGURATION_RISK",
      severity: "informational",
      severityRationale: "a beacon introduces an external implementation dependency without proving it is unsafe",
      confidence: "high",
      affectedAddress: request.target.address,
      affectedFunction: null,
      sourceLocation: null,
      evidence: [{
        kind: "storage_slot",
        reference: `erc1967.beacon@${blockNumber}`,
        contentHash: request.snapshot.blockHash,
      }],
      preconditions: ["the target follows the ERC-1967 beacon path"],
      potentialConsequence: "a beacon change can alter implementation behavior",
      mitigation: "review beacon ownership, upgrade policy, delay, and emitted events",
      validationMethod: "read the ERC-1967 beacon storage slot at the pinned block",
    })
  }
}

function refusal(
  status: "REFUSED" | "INVALID_REQUEST",
  reasonCode: string,
  now: Date,
  request: ShieldRequest | null,
): ShieldArtifact {
  return shieldArtifact.parse({
    schemaVersion: "knot.shield.artifact/1",
    category: "security",
    capability: "analysis",
    taskId: request?.taskId ?? null,
    status,
    reasonCode,
    assessedAtUtc: now.toISOString(),
    target: { chainId: 56, address: request?.target.address ?? null },
    snapshot: {
      blockNumber: request?.snapshot.blockNumber ?? null,
      blockHash: request?.snapshot.blockHash ?? null,
      sourceBundleHash: request?.snapshot.verifiedSource.status === "available"
        ? request.snapshot.verifiedSource.sourceBundleHash
        : null,
    },
    proxy: { standard: "ERC-1967", implementation: null, admin: null, beacon: null },
    findings: [],
    negativeControls: [],
    unresolved: [{
      check: reasonCode,
      reason: "the request cannot produce a bounded assessment",
      consequence: "no contract-risk conclusion is returned",
    }],
    limitations,
  })
}

function isStale(capturedAtUtc: string, maxSnapshotAgeSeconds: number, now: Date): boolean {
  return Math.abs(now.getTime() - new Date(capturedAtUtc).getTime()) / 1000 > maxSnapshotAgeSeconds
}
