import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { expectedPublicSellers } from "../../packages/discovery/src/public-sellers.ts"
import { parseTunnelDrillInvocation, tunnelRecoveryLimitations, verifyTunnelRecoveryEvidence, verifyTunnelRecoveryPublicationBindings } from "../../packages/reliability/src/tunnel-recovery.ts"

const nonceBefore = "1".repeat(32)
const nonceAfter = "2".repeat(32)
const artifactDigest = "581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2"
const artifactUrl = `https://knot-artifacts.truematchx.com/knot-deliverables/healthguard/sha256/${artifactDigest}.json`
const containerNames = [
  ["healthguard", "knot-healthguard-agent-1"],
  ["rangepilot", "knot-rangepilot-agent-1"],
  ["gridquant", "knot-gridquant-agent-1"],
  ["yieldscout", "knot-yieldscout-agent-1"],
] as const

test("accepts a bounded tunnel-only restart with complete public recovery and unchanged containers", () => {
  const evidence = verifyTunnelRecoveryEvidence(fixture())
  assert.equal(evidence.result, "RECOVERED")
  assert.equal(evidence.timing.restartToCompletePublicRecoveryMs, 4_000)
  assert.equal(evidence.publicAfter.sellers.length, 4)
})

test("published claim and documentation derive their measured values from the captured record", () => {
  const evidence = JSON.parse(readFileSync("evidence/operations/tunnel-recovery-20260909.json", "utf8")) as unknown
  const claim = publishedClaim()
  const summary = verifyTunnelRecoveryPublicationBindings(evidence, claim, readFileSync("README.md", "utf8"), readFileSync("REPRODUCE.md", "utf8"))
  assert.equal(summary.recoveryDurationMs, 12_832)
  assert.equal(summary.recoveryProbeAttempts, 1)
})

test("publication binding rejects flattering recovery edits and stale documentation", () => {
  const evidence = JSON.parse(readFileSync("evidence/operations/tunnel-recovery-20260909.json", "utf8")) as unknown
  const claim = structuredClone(publishedClaim())
  ;(claim.scope as Record<string, unknown>).recoveryDurationMs = 1
  assert.throws(() => verifyTunnelRecoveryPublicationBindings(evidence, claim, readFileSync("README.md", "utf8"), readFileSync("REPRODUCE.md", "utf8")), /claim scope/)
  assert.throws(() => verifyTunnelRecoveryPublicationBindings(evidence, publishedClaim(), "", readFileSync("REPRODUCE.md", "utf8")), /README text/)
})

test("published tunnel evidence contains no credential, SSH target, or service command material", () => {
  const raw = readFileSync("evidence/operations/tunnel-recovery-20260909.json", "utf8")
  assert.doesNotMatch(raw, /access[_-]?token|authorization|bearer|client[_-]?secret|password|private[_-]?key|root@|76\.13\.|ExecStart|--token/i)
})

test("requires explicit execution, a plain SSH destination, and an allowlisted output path", () => {
  assert.throws(() => parseTunnelDrillInvocation([], { KNOT_RELIABILITY_SSH_HOST: "root@192.0.2.1" }), /explicit --execute/)
  assert.throws(() => parseTunnelDrillInvocation(["--execute"], {}), /KNOT_RELIABILITY_SSH_HOST/)
  assert.throws(() => parseTunnelDrillInvocation(["--execute", "--output", ".secrets/reliability/tunnel-recovery-latest.json", "--output", ".secrets/reliability/again.json"], { KNOT_RELIABILITY_SSH_HOST: "root@192.0.2.1" }), /duplicate/)
  assert.throws(() => parseTunnelDrillInvocation(["--execute"], { KNOT_RELIABILITY_SSH_HOST: "-oProxyCommand=bad" }), /plain SSH destination/)
  assert.throws(() => parseTunnelDrillInvocation(["--execute", "--output", "../evidence.json"], { KNOT_RELIABILITY_SSH_HOST: "root@192.0.2.1" }), /not allowlisted/)
  assert.deepEqual(parseTunnelDrillInvocation(["--execute"], { KNOT_RELIABILITY_SSH_HOST: "root@192.0.2.1" }), {
    sshHost: "root@192.0.2.1",
    outputPath: ".secrets/reliability/tunnel-recovery-latest.json",
  })
})

test("capture source has one literal remote mutation and omits sensitive systemd properties", () => {
  const source = readFileSync("scripts/run-tunnel-recovery-drill.ts", "utf8")
  assert.equal(source.match(/remote\(\["systemctl", "restart", "cloudflared"\]/g)?.length, 1)
  assert.ok(source.includes('"BatchMode=yes"'))
  assert.ok(!source.includes("ExecStart"))
  assert.ok(!/remote\(\["docker", "(?:restart|stop|start|rm)"/.test(source))
  assert.ok(!/remote\(\["systemctl", "(?:reboot|poweroff|restart)", "docker"/.test(source))
})

test("rejects widened mutation, authentication, chain, and fund boundaries", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => boundary(value).remoteMutationCommands = ["systemctl restart cloudflared", "systemctl restart docker"],
    (value: Record<string, unknown>) => boundary(value).dockerMutationCommands = 1,
    (value: Record<string, unknown>) => boundary(value).authenticatedSellerRequests = 1,
    (value: Record<string, unknown>) => boundary(value).chainRpcRequests = 1,
    (value: Record<string, unknown>) => boundary(value).fundTransferCommands = 1,
  ]) {
    const value = fixture()
    mutate(value)
    assert.throws(() => verifyTunnelRecoveryEvidence(value))
  }
})

test("rejects inactive, disabled, reconfigured, or unrestarted cloudflared evidence", () => {
  const inactive = fixture()
  service(inactive, "serviceAfter").activeState = "inactive"
  assert.throws(() => verifyTunnelRecoveryEvidence(inactive))

  const disabled = fixture()
  service(disabled, "serviceAfter").unitFileState = "disabled"
  assert.throws(() => verifyTunnelRecoveryEvidence(disabled))

  const reconfigured = fixture()
  service(reconfigured, "serviceAfter").restartPolicy = "always"
  assert.throws(() => verifyTunnelRecoveryEvidence(reconfigured), /restartPolicy changed/)

  const sameInvocation = fixture()
  service(sameInvocation, "serviceAfter").invocationId = service(sameInvocation, "serviceBefore").invocationId
  assert.throws(() => verifyTunnelRecoveryEvidence(sameInvocation), /new service invocation/)

  const staleTimestamp = fixture()
  service(staleTimestamp, "serviceAfter").activeEnterTimestampMonotonicMicros = "999"
  assert.throws(() => verifyTunnelRecoveryEvidence(staleTimestamp), /did not advance/)
})

test("rejects any seller container restart or image replacement", () => {
  const restarted = fixture()
  containers(restarted, "containersAfter")[0]!.startedAtUtc = "2026-09-09T00:00:03.500Z"
  assert.throws(() => verifyTunnelRecoveryEvidence(restarted), /container restarted/)

  const replaced = fixture()
  containers(replaced, "containersAfter")[1]!.immutableImageId = `sha256:${"f".repeat(64)}`
  assert.throws(() => verifyTunnelRecoveryEvidence(replaced), /container restarted/)
})

test("rejects unhealthy API, tampered bodies, and invalid seller identity responses", () => {
  const unavailableDatabase = fixture()
  replaceBody(publicSnapshot(unavailableDatabase, "publicAfter").apiHealth as Record<string, unknown>, { service: "knot-api", status: "AVAILABLE", dependencies: { database: "UNAVAILABLE" } })
  assert.throws(() => verifyTunnelRecoveryEvidence(unavailableDatabase))

  const bodyTamper = fixture()
  ;(publicSnapshot(bodyTamper, "publicAfter").apiHealth as Record<string, unknown>).bodyBase64 = Buffer.from("{}").toString("base64")
  assert.throws(() => verifyTunnelRecoveryEvidence(bodyTamper), /length mismatch/)

  const wrongCard = fixture()
  const seller = sellers(publicSnapshot(wrongCard, "publicAfter"))[0]!
  replaceBody(seller.agentCard as Record<string, unknown>, cardBody(expectedPublicSellers[0]!, "impostor"))
  assert.throws(() => verifyTunnelRecoveryEvidence(wrongCard))

  const wrongRegistration = fixture()
  const registration = sellers(publicSnapshot(wrongRegistration, "publicAfter"))[2]!.domainRegistration as Record<string, unknown>
  replaceBody(registration, { registrations: [{ agentId: 1, agentRegistry: "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e" }] })
  assert.throws(() => verifyTunnelRecoveryEvidence(wrongRegistration), /registration identity mismatch/)
})

test("rejects an altered retained artifact, reused nonce, and inconsistent recovery timing", () => {
  const artifact = fixture()
  ;(publicSnapshot(artifact, "publicAfter").retainedArtifact as Record<string, unknown>).expectedSha256 = "0".repeat(64)
  assert.throws(() => verifyTunnelRecoveryEvidence(artifact))

  const nonce = fixture()
  rewriteSnapshotNonce(publicSnapshot(nonce, "publicAfter"), nonceBefore)
  assert.throws(() => verifyTunnelRecoveryEvidence(nonce), /distinct cache-busting nonces/)

  const timing = fixture()
  ;(timing.timing as Record<string, unknown>).restartToCompletePublicRecoveryMs = 3_999
  assert.throws(() => verifyTunnelRecoveryEvidence(timing), /duration does not match/)

  const reordered = fixture()
  ;(reordered.timing as Record<string, unknown>).restartCommandCompletedAtUtc = "2026-09-09T00:00:05.000Z"
  assert.throws(() => verifyTunnelRecoveryEvidence(reordered), /timing is not ordered/)
})

test("rejects unknown fields and removed mandatory limitations", () => {
  const unknown = fixture()
  unknown.unreviewed = true
  assert.throws(() => verifyTunnelRecoveryEvidence(unknown))

  const limitations = fixture()
  ;(limitations.limitations as unknown[]).pop()
  assert.throws(() => verifyTunnelRecoveryEvidence(limitations))

  const sensitiveServiceField = fixture()
  service(sensitiveServiceField, "serviceBefore").execStart = "/usr/bin/cloudflared --token secret"
  assert.throws(() => verifyTunnelRecoveryEvidence(sensitiveServiceField))

  const excessiveLatency = fixture()
  ;(publicSnapshot(excessiveLatency, "publicAfter").apiHealth as Record<string, unknown>).latencyMs = 10_001
  assert.throws(() => verifyTunnelRecoveryEvidence(excessiveLatency), /configured timeout/)
})

function fixture(): Record<string, unknown> {
  const artifact = artifactBody()
  return {
    schemaVersion: "knot.tunnel-recovery-evidence/1",
    observedFromUtc: "2026-09-09T00:00:00.000Z",
    observedUntilUtc: "2026-09-09T00:00:06.000Z",
    gitCommit: "a".repeat(40),
    result: "RECOVERED",
    drill: { mode: "controlled-cloudflared-service-restart", command: "npm run tunnel:drill -- --execute", targetUnit: "cloudflared.service", recoveryTimeoutMs: 120_000, pollIntervalMs: 1_000, httpRequestTimeoutMs: 10_000, recoveryProbeAttempts: 2 },
    boundary: {
      explicitExecutionFlag: true, sshBatchMode: true, remoteMutationCommands: ["systemctl restart cloudflared"], remoteMutationCommandCount: 1,
      dockerMutationCommands: 0, containerRestartCommands: 0, dockerDaemonRestarted: false, vpsRestarted: false, authenticatedSellerRequests: 0,
      commerceMutationCommands: 0, chainRpcRequests: 0, transactionSubmissions: 0, mainnetWriteCommands: 0, fundTransferCommands: 0, networkTrafficInstrumented: false,
    },
    serviceBefore: systemd(100, "a".repeat(32), "1000"),
    serviceAfter: systemd(200, "b".repeat(32), "2000"),
    containersBefore: docker(),
    containersAfter: docker(),
    publicBefore: publicProbe(nonceBefore, "2026-09-09T00:00:00.000Z", "2026-09-09T00:00:01.000Z", artifact),
    publicAfter: publicProbe(nonceAfter, "2026-09-09T00:00:04.000Z", "2026-09-09T00:00:06.000Z", artifact),
    timing: { restartRequestedAtUtc: "2026-09-09T00:00:02.000Z", restartCommandCompletedAtUtc: "2026-09-09T00:00:03.000Z", completePublicRecoveryAtUtc: "2026-09-09T00:00:06.000Z", restartToCompletePublicRecoveryMs: 4_000 },
    limitations: [...tunnelRecoveryLimitations],
  }
}

function systemd(mainPid: number, invocationId: string, activeEnterTimestampMonotonicMicros: string) {
  return {
    unitId: "cloudflared.service", names: ["cloudflared.service"], description: "cloudflared", loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled",
    restartPolicy: "on-failure", restartDelay: "5s", startLimitInterval: "10s", startLimitBurst: 5, automaticRestartCount: 0, mainPid, invocationId, activeEnterTimestampMonotonicMicros, result: "success",
  }
}

function docker() {
  return containerNames.map(([key, name], index) => ({ key, name, imageReference: `knot/${key}:release`, immutableImageId: `sha256:${String(index + 1).repeat(64)}`, startedAtUtc: "2026-09-08T00:00:00.000Z", running: true, health: "healthy" }))
}

function publicProbe(nonce: string, observedAtUtc: string, completedAtUtc: string, artifact: Uint8Array) {
  return {
    requestNonce: nonce,
    observedAtUtc,
    completedAtUtc,
    apiHealth: captured("https://knot-api.truematchx.com/health", nonce, Buffer.from(JSON.stringify({ service: "knot-api", status: "AVAILABLE", dependencies: { database: "AVAILABLE" } }))),
    sellers: expectedPublicSellers.map((seller) => ({
      key: seller.key,
      agentId: seller.agentId,
      agentCard: captured(`${seller.origin}/.well-known/agent-card.json`, nonce, Buffer.from(JSON.stringify(cardBody(seller, seller.cardName)))),
      domainRegistration: captured(`${seller.origin}/.well-known/agent-registration.json`, nonce, Buffer.from(JSON.stringify({ registrations: [{ agentId: seller.agentId, agentRegistry: "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e" }] }))),
      unauthenticatedInvocation: { url: withNonce(`${seller.origin}/`, nonce), httpStatus: 401, latencyMs: 50 },
    })),
    retainedArtifact: { sellerKey: "healthguard", expectedSha256: artifactDigest, response: captured(artifactUrl, nonce, artifact) },
  }
}

function cardBody(seller: typeof expectedPublicSellers[number], name: string) {
  return {
    name, url: `${seller.origin}/`, protocolVersion: "0.3.0", preferredTransport: "JSONRPC", skills: [{ id: "negotiate" }, { id: "notify_funded" }],
    securitySchemes: { oauth2: { flows: { clientCredentials: { tokenUrl: `${seller.origin}/oauth/token`, scopes: { [seller.oauthScope]: "invoke" } } } } },
    security: [{ oauth2: [seller.oauthScope] }],
  }
}

function artifactBody(): Uint8Array {
  const job = JSON.parse(readFileSync("evidence/advantage/healthguard-1185/job-1185.json", "utf8")) as { deliverable: { artifact: unknown } }
  return Buffer.from(JSON.stringify({
    chain_id: 97,
    contracts: { commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE", policy: "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA", router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25" },
    job_id: 1185,
    metadata: { built_with: "https://github.com/bnb-chain/bnbagent-studio", generator: "healthguard", job_id: 1185 },
    response: { content: JSON.stringify(job.deliverable.artifact), content_type: "text/plain" },
    version: 1,
  }))
}

function captured(url: string, nonce: string, bytes: Uint8Array) {
  return { url: withNonce(url, nonce), httpStatus: 200, latencyMs: 50, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, bodyBase64: Buffer.from(bytes).toString("base64") }
}

function withNonce(value: string, nonce: string): string {
  const url = new URL(value)
  url.searchParams.set("tunnel-recovery", nonce)
  return url.toString()
}

function boundary(value: Record<string, unknown>): Record<string, unknown> {
  return value.boundary as Record<string, unknown>
}

function service(value: Record<string, unknown>, key: "serviceBefore" | "serviceAfter"): Record<string, unknown> {
  return value[key] as Record<string, unknown>
}

function containers(value: Record<string, unknown>, key: "containersBefore" | "containersAfter"): Array<Record<string, unknown>> {
  return value[key] as Array<Record<string, unknown>>
}

function publicSnapshot(value: Record<string, unknown>, key: "publicBefore" | "publicAfter"): Record<string, unknown> {
  return value[key] as Record<string, unknown>
}

function sellers(snapshot: Record<string, unknown>): Array<Record<string, unknown>> {
  return snapshot.sellers as Array<Record<string, unknown>>
}

function replaceBody(response: Record<string, unknown>, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  response.sha256 = createHash("sha256").update(bytes).digest("hex")
  response.byteLength = bytes.byteLength
  response.bodyBase64 = bytes.toString("base64")
}

function rewriteSnapshotNonce(snapshot: Record<string, unknown>, nonce: string): void {
  snapshot.requestNonce = nonce
  for (const response of [snapshot.apiHealth as Record<string, unknown>, (snapshot.retainedArtifact as Record<string, unknown>).response as Record<string, unknown>]) {
    response.url = withNonce(new URL(response.url as string).origin + new URL(response.url as string).pathname, nonce)
  }
  for (const seller of sellers(snapshot)) {
    for (const key of ["agentCard", "domainRegistration", "unauthenticatedInvocation"]) {
      const response = seller[key] as Record<string, unknown>
      const url = new URL(response.url as string)
      response.url = withNonce(`${url.origin}${url.pathname}`, nonce)
    }
  }
}

function publishedClaim(): Record<string, unknown> {
  const ledger = JSON.parse(readFileSync("evidence/claims.json", "utf8")) as { claims: Array<Record<string, unknown>> }
  const claim = ledger.claims.find((item) => item.id === "cloudflared-controlled-recovery")
  assert.ok(claim)
  return claim
}
