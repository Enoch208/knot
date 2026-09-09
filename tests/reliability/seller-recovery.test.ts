import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { verifySellerAvailabilityEvidence } from "../../packages/reliability/src/seller-availability.ts"
import { parseSellerRecoveryDrillInvocation, verifySellerRecoveryEvidence, verifySellerRecoveryPublicationBindings } from "../../packages/reliability/src/seller-recovery.ts"

const evidencePath = "evidence/operations/seller-recovery-20260909.json"
const availabilityPath = "evidence/operations/seller-availability-20260909.json"
const readEvidence = (): unknown => JSON.parse(readFileSync(evidencePath, "utf8"))
const cloneEvidence = (): Record<string, unknown> => structuredClone(verifySellerRecoveryEvidence(readEvidence()))
const readClaim = (): Record<string, unknown> => {
  const document = JSON.parse(readFileSync("evidence/claims.json", "utf8")) as { claims: Array<Record<string, unknown>> }
  const claim = document.claims.find((candidate) => candidate.id === "seller-restart-recovery")
  if (claim === undefined) throw new Error("seller recovery claim is missing")
  return claim
}
const sellers = (evidence: Record<string, unknown>): Array<Record<string, unknown>> => {
  assert.ok(Array.isArray(evidence.sellers))
  return evidence.sellers as Array<Record<string, unknown>>
}

test("four public sellers recover sequentially with immutable images and durable artifacts", () => {
  const evidence = verifySellerRecoveryEvidence(readEvidence())
  assert.deepEqual(evidence.sellers.map((seller) => seller.key), ["healthguard", "rangepilot", "gridquant", "yieldscout"])
  for (const seller of evidence.sellers) {
    assert.equal(seller.image.immutableIdBefore, seller.image.immutableIdAfter)
    assert.ok(Date.parse(seller.container.startedAtAfterUtc) > Date.parse(seller.container.startedAtBeforeUtc))
    assert.equal(seller.publicSurfaceAfter.retainedArtifact.sha256, seller.publicSurfaceBefore.retainedArtifact.sha256)
    assert.equal(seller.authenticatedQuoteAfter.accepted, true)
    assert.equal(seller.authenticatedQuoteAfter.chainId, 97)
  }
})

test("recovery evidence preserves the measured mutation boundary", () => {
  const evidence = verifySellerRecoveryEvidence(readEvidence())
  assert.deepEqual(evidence.boundary, {
    onlyStateChangingOperation: "seller-container-restart",
    dockerDaemonRestarted: false,
    vpsRestarted: false,
    cloudflaredRestarted: false,
    networkTrafficInstrumented: false,
    commerceMutationCommands: 0,
    mainnetWriteCommands: 0,
    fundTransferCommands: 0,
  })
})

test("published recovery evidence contains no credential or SSH target material", () => {
  const raw = readFileSync(evidencePath, "utf8")
  assert.doesNotMatch(raw, /access[_-]?token|authorization|bearer|client[_-]?secret|password|private[_-]?key|root@|76\.13\./i)
})

test("recovery verifier rejects a changed image", () => {
  const evidence = cloneEvidence()
  const image = sellers(evidence)[0]?.image as Record<string, unknown>
  image.immutableIdAfter = `sha256:${"0".repeat(64)}`
  assert.throws(() => verifySellerRecoveryEvidence(evidence), /image changed/)
})

test("recovery verifier rejects a missing seller", () => {
  const evidence = cloneEvidence()
  evidence.sellers = sellers(evidence).slice(0, 3)
  assert.throws(() => verifySellerRecoveryEvidence(evidence))
})

test("recovery verifier rejects seller order tampering", () => {
  const evidence = cloneEvidence()
  const orderedSellers = sellers(evidence)
  const first = orderedSellers[0]
  const second = orderedSellers[1]
  assert.ok(first)
  assert.ok(second)
  orderedSellers[0] = second
  orderedSellers[1] = first
  assert.throws(() => verifySellerRecoveryEvidence(evidence), /order mismatch/)
})

test("recovery verifier rejects overlapping seller restarts", () => {
  const evidence = cloneEvidence()
  const orderedSellers = sellers(evidence)
  const firstTiming = orderedSellers[0]?.timing as Record<string, unknown>
  const secondTiming = orderedSellers[1]?.timing as Record<string, unknown>
  const firstRecoveredAtUtc = firstTiming.recoveredAtUtc
  const secondRecoveredAtUtc = secondTiming.recoveredAtUtc
  if (typeof firstRecoveredAtUtc !== "string" || typeof secondRecoveredAtUtc !== "string") throw new Error("recovery fixture timestamps are missing")
  const overlappingRequest = new Date(Date.parse(firstRecoveredAtUtc) - 1).toISOString()
  secondTiming.restartRequestedAtUtc = overlappingRequest
  secondTiming.recoveryDurationMs = Date.parse(secondRecoveredAtUtc) - Date.parse(overlappingRequest)
  assert.throws(() => verifySellerRecoveryEvidence(evidence), /overlaps preceding seller recovery/)
})

test("recovery verifier rejects a forged recovery duration", () => {
  const evidence = cloneEvidence()
  const timing = sellers(evidence)[0]?.timing as Record<string, unknown>
  timing.recoveryDurationMs = 1
  assert.throws(() => verifySellerRecoveryEvidence(evidence), /duration/)
})

test("recovery verifier rejects lost artifacts and widened authority", () => {
  const artifactEvidence = cloneEvidence()
  const surface = sellers(artifactEvidence)[0]?.publicSurfaceAfter as Record<string, unknown>
  const artifact = surface.retainedArtifact as Record<string, unknown>
  artifact.sha256 = "0".repeat(64)
  assert.throws(() => verifySellerRecoveryEvidence(artifactEvidence), /artifact digest mismatch/)

  const boundaryEvidence = cloneEvidence()
  const boundary = boundaryEvidence.boundary as Record<string, unknown>
  boundary.commerceMutationCommands = 1
  assert.throws(() => verifySellerRecoveryEvidence(boundaryEvidence))
})

test("recovery verifier rejects substituted public paths and quote contracts", () => {
  const pathEvidence = cloneEvidence()
  const surface = sellers(pathEvidence)[0]?.publicSurfaceAfter as Record<string, unknown>
  const card = surface.agentCard as Record<string, unknown>
  card.url = "https://knot-health.truematchx.com/not-the-card.json"
  assert.throws(() => verifySellerRecoveryEvidence(pathEvidence), /card URL mismatch/)

  const contractEvidence = cloneEvidence()
  const quote = sellers(contractEvidence)[0]?.authenticatedQuoteAfter as Record<string, unknown>
  quote.verifyingContract = `0x${"0".repeat(40)}`
  assert.throws(() => verifySellerRecoveryEvidence(contractEvidence), /quote contract mismatch/)
})

test("recovery surfaces bind to identity-verified captured card and registration bodies", () => {
  const recovery = verifySellerRecoveryEvidence(readEvidence())
  const availability = verifySellerAvailabilityEvidence(JSON.parse(readFileSync(availabilityPath, "utf8")))
  const identities = new Map(availability.rounds[0]?.sellers.map((seller) => [seller.key, seller.requests]))
  for (const seller of recovery.sellers) {
    const identity = identities.get(seller.key)
    assert.ok(identity)
    for (const surface of [seller.publicSurfaceBefore, seller.publicSurfaceAfter]) {
      assert.deepEqual(
        { sha256: surface.agentCard.sha256, byteLength: surface.agentCard.byteLength },
        { sha256: identity.agentCard.sha256, byteLength: identity.agentCard.byteLength },
      )
      assert.deepEqual(
        { sha256: surface.domainRegistration.sha256, byteLength: surface.domainRegistration.byteLength },
        { sha256: identity.domainRegistration.sha256, byteLength: identity.domainRegistration.byteLength },
      )
    }
  }
})

test("recovery verifier rejects unrelated or changed 200 response bodies", () => {
  const unrelated = cloneEvidence()
  const unrelatedSeller = sellers(unrelated)[0]
  assert.ok(unrelatedSeller)
  const unrelatedBefore = unrelatedSeller.publicSurfaceBefore as Record<string, Record<string, unknown>>
  const unrelatedAfter = unrelatedSeller.publicSurfaceAfter as Record<string, Record<string, unknown>>
  const unrelatedBeforeCard = unrelatedBefore.agentCard
  const unrelatedAfterCard = unrelatedAfter.agentCard
  assert.ok(unrelatedBeforeCard)
  assert.ok(unrelatedAfterCard)
  unrelatedBeforeCard.sha256 = "0".repeat(64)
  unrelatedAfterCard.sha256 = "0".repeat(64)
  assert.throws(() => verifySellerRecoveryEvidence(unrelated), /identity-verified release/)

  const changed = cloneEvidence()
  const changedSurface = sellers(changed)[1]?.publicSurfaceAfter as Record<string, Record<string, unknown>>
  const changedRegistration = changedSurface.domainRegistration
  assert.ok(changedRegistration)
  changedRegistration.sha256 = "f".repeat(64)
  assert.throws(() => verifySellerRecoveryEvidence(changed), /registration body/)

  const truncated = cloneEvidence()
  const truncatedSurface = sellers(truncated)[2]?.publicSurfaceBefore as Record<string, Record<string, unknown>>
  const truncatedCard = truncatedSurface.agentCard
  assert.ok(truncatedCard)
  truncatedCard.byteLength = 1
  assert.throws(() => verifySellerRecoveryEvidence(truncated), /card body/)
})

test("published recovery claim and README measurements derive from recovery evidence", () => {
  const summary = verifySellerRecoveryPublicationBindings(readEvidence(), readClaim(), readFileSync("README.md", "utf8"))
  assert.deepEqual(summary.recoveryDurationMs, { healthguard: 20091, rangepilot: 20606, gridquant: 25192, yieldscout: 25300 })
  assert.equal(summary.maximumRecoveryDurationMs, 25300)
})

test("publication bindings reject drifted claims and README values", () => {
  const claim = structuredClone(readClaim())
  const scope = claim.scope as Record<string, unknown>
  scope.maximumRecoveryDurationMs = 1
  assert.throws(() => verifySellerRecoveryPublicationBindings(readEvidence(), claim, readFileSync("README.md", "utf8")), /durations/)
  assert.throws(() => verifySellerRecoveryPublicationBindings(readEvidence(), readClaim(), ""), /README/)
})

test("seller recovery drill invocation accepts only the explicit execution form and allowlisted outputs", () => {
  const environment = { KNOT_RELIABILITY_SSH_HOST: "root@76.13.106.173" }
  assert.deepEqual(parseSellerRecoveryDrillInvocation(["--execute"], environment), {
    sshHost: "root@76.13.106.173",
    outputPath: ".secrets/reliability/seller-recovery-latest.json",
  })
  assert.deepEqual(parseSellerRecoveryDrillInvocation(["--execute"], { ...environment, KNOT_RELIABILITY_OUTPUT: "evidence/operations/seller-recovery-20260909.json" }).outputPath, "evidence/operations/seller-recovery-20260909.json")
  for (const argv of [[], ["--execute", "--verbose"], ["--execute", "--execute"], ["--dry-run"]]) {
    assert.throws(() => parseSellerRecoveryDrillInvocation(argv, environment), /exactly --execute/)
  }
  assert.throws(() => parseSellerRecoveryDrillInvocation(["--execute"], { KNOT_RELIABILITY_SSH_HOST: "-oProxyCommand=touch" }), /plain SSH destination/)
  assert.throws(() => parseSellerRecoveryDrillInvocation(["--execute"], { ...environment, KNOT_RELIABILITY_OUTPUT: "../seller-recovery.json" }), /not allowlisted/)
})

test("seller recovery drill reserves an allowlisted output exclusively before a restart", () => {
  const source = readFileSync("scripts/run-seller-recovery-drill.ts", "utf8")
  const reservation = source.indexOf('open(outputPath, "wx", 0o600)')
  const restart = source.indexOf('remote(["docker", "restart"')
  assert.ok(reservation >= 0)
  assert.ok(restart > reservation)
  assert.doesNotMatch(source, /writeFile\(outputPath/)
  assert.match(source, /parseSellerRecoveryDrillInvocation\(process\.argv\.slice\(2\), process\.env\)/)
})
