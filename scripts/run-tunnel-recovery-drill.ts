import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"
import { expectedPublicSellers } from "../packages/discovery/src/public-sellers.ts"
import { parseTunnelDrillInvocation, tunnelRecoveryLimitations, verifyTunnelPublicSnapshot, verifyTunnelRecoveryEvidence, type TunnelPublicSnapshot } from "../packages/reliability/src/tunnel-recovery.ts"
import { safeFetch } from "../packages/security/src/index.ts"

const execute = promisify(execFile)
const invocation = parseTunnelDrillInvocation(process.argv.slice(2), process.env)
const recoveryTimeoutMs = 120_000
const pollIntervalMs = 1_000
const requestTimeoutMs = 10_000
const containerNames = [
  ["healthguard", "knot-healthguard-agent-1"],
  ["rangepilot", "knot-rangepilot-agent-1"],
  ["gridquant", "knot-gridquant-agent-1"],
  ["yieldscout", "knot-yieldscout-agent-1"],
] as const
const artifactUrl = "https://knot-artifacts.truematchx.com/knot-deliverables/healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json"
const artifactSha256 = "581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2" as const

type ServiceSnapshot = {
  unitId: "cloudflared.service"
  names: string[]
  description: string
  loadState: "loaded"
  activeState: "active"
  subState: "running"
  unitFileState: "enabled"
  restartPolicy: "on-success" | "on-failure" | "on-abnormal" | "on-watchdog" | "on-abort" | "always" | "debug"
  restartDelay: string
  startLimitInterval: string
  startLimitBurst: number
  automaticRestartCount: number
  mainPid: number
  invocationId: string
  activeEnterTimestampMonotonicMicros: string
  result: "success"
}

type ContainerSnapshot = {
  key: typeof containerNames[number][0]
  name: string
  imageReference: string
  immutableImageId: string
  startedAtUtc: string
  running: true
  health: "healthy"
}

type CapturedResponse = {
  url: string
  httpStatus: 200
  latencyMs: number
  sha256: string
  byteLength: number
  bodyBase64: string
}

const serviceBefore = await readServiceSnapshot()
const containersBefore = await readContainerSnapshots()
const publicBefore = await capturePublicSnapshot()
const observedFromUtc = publicBefore.observedAtUtc
const restartRequestedAtUtc = new Date().toISOString()
const deadlineAt = Date.parse(restartRequestedAtUtc) + recoveryTimeoutMs
await remote(["systemctl", "restart", "cloudflared"], remainingMs(deadlineAt))
const restartCommandCompletedAtUtc = new Date().toISOString()
let recoveryProbeAttempts = 0
let evidence: unknown = null

while (Date.now() < deadlineAt) {
  recoveryProbeAttempts += 1
  try {
    const serviceAfter = await readServiceSnapshot()
    const containersAfter = await readContainerSnapshots()
    assertContainersUnchanged(containersBefore, containersAfter)
    const publicAfter = await capturePublicSnapshot()
    const completePublicRecoveryAtUtc = publicAfter.completedAtUtc
    evidence = verifyTunnelRecoveryEvidence({
      schemaVersion: "knot.tunnel-recovery-evidence/1",
      observedFromUtc,
      observedUntilUtc: completePublicRecoveryAtUtc,
      gitCommit: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
      result: "RECOVERED",
      drill: {
        mode: "controlled-cloudflared-service-restart",
        command: "npm run tunnel:drill -- --execute",
        targetUnit: "cloudflared.service",
        recoveryTimeoutMs,
        pollIntervalMs,
        httpRequestTimeoutMs: requestTimeoutMs,
        recoveryProbeAttempts,
      },
      boundary: {
        explicitExecutionFlag: true,
        sshBatchMode: true,
        remoteMutationCommands: ["systemctl restart cloudflared"],
        remoteMutationCommandCount: 1,
        dockerMutationCommands: 0,
        containerRestartCommands: 0,
        dockerDaemonRestarted: false,
        vpsRestarted: false,
        authenticatedSellerRequests: 0,
        commerceMutationCommands: 0,
        chainRpcRequests: 0,
        transactionSubmissions: 0,
        mainnetWriteCommands: 0,
        fundTransferCommands: 0,
        networkTrafficInstrumented: false,
      },
      serviceBefore,
      serviceAfter,
      containersBefore,
      containersAfter,
      publicBefore,
      publicAfter,
      timing: {
        restartRequestedAtUtc,
        restartCommandCompletedAtUtc,
        completePublicRecoveryAtUtc,
        restartToCompletePublicRecoveryMs: Date.parse(completePublicRecoveryAtUtc) - Date.parse(restartRequestedAtUtc),
      },
      limitations: tunnelRecoveryLimitations,
    })
    break
  } catch {
    process.stderr.write(`[tunnel-recovery] public recovery probe ${recoveryProbeAttempts} incomplete\n`)
  }
  const waitMs = Math.min(pollIntervalMs, Math.max(0, deadlineAt - Date.now()))
  if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
}

if (evidence === null) throw new Error(`cloudflared did not complete every public recovery check within ${recoveryTimeoutMs} ms`)
await mkdir(dirname(invocation.outputPath), { recursive: true })
await writeFile(invocation.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
process.stdout.write(`${invocation.outputPath}\n`)

async function readServiceSnapshot(): Promise<ServiceSnapshot> {
  const names = ["Id", "Names", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "Restart", "RestartUSec", "StartLimitIntervalUSec", "StartLimitBurst", "NRestarts", "MainPID", "InvocationID", "ActiveEnterTimestampMonotonic", "Result"] as const
  const raw = await remote(["systemctl", "show", "cloudflared", "--no-pager", ...names.map((name) => `--property=${name}`)], 20_000)
  const values = new Map<string, string>()
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=")
    if (separator <= 0) throw new Error("systemd returned an invalid property line")
    const key = line.slice(0, separator)
    if (!names.includes(key as typeof names[number]) || values.has(key)) throw new Error("systemd returned an unexpected or duplicate property")
    values.set(key, line.slice(separator + 1))
  }
  if (values.size !== names.length) throw new Error("systemd omitted a required property")
  return {
    unitId: exact(values, "Id", "cloudflared.service"),
    names: required(values, "Names").split(" "),
    description: required(values, "Description"),
    loadState: exact(values, "LoadState", "loaded"),
    activeState: exact(values, "ActiveState", "active"),
    subState: exact(values, "SubState", "running"),
    unitFileState: exact(values, "UnitFileState", "enabled"),
    restartPolicy: restartPolicy(required(values, "Restart")),
    restartDelay: required(values, "RestartUSec"),
    startLimitInterval: required(values, "StartLimitIntervalUSec"),
    startLimitBurst: unsignedInteger(values, "StartLimitBurst"),
    automaticRestartCount: unsignedInteger(values, "NRestarts"),
    mainPid: positiveInteger(values, "MainPID"),
    invocationId: required(values, "InvocationID"),
    activeEnterTimestampMonotonicMicros: required(values, "ActiveEnterTimestampMonotonic"),
    result: exact(values, "Result", "success"),
  }
}

async function readContainerSnapshots(): Promise<ContainerSnapshot[]> {
  const format = '{"name":"{{.Name}}","imageReference":"{{.Config.Image}}","immutableImageId":"{{.Image}}","startedAtUtc":"{{.State.StartedAt}}","running":{{.State.Running}},"health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}"}'
  const raw = await remote(["docker", "inspect", "--format", format, ...containerNames.map((entry) => entry[1])], 20_000)
  const lines = raw.split("\n")
  if (lines.length !== containerNames.length) throw new Error("docker inspect returned an incomplete container set")
  return lines.map((line, index) => {
    const parsed = JSON.parse(line) as Record<string, unknown>
    const expected = containerNames[index]
    if (expected === undefined || parsed.name !== `/${expected[1]}` || parsed.running !== true || parsed.health !== "healthy") throw new Error("docker inspect returned an unexpected container state")
    if (typeof parsed.imageReference !== "string" || typeof parsed.immutableImageId !== "string" || typeof parsed.startedAtUtc !== "string") throw new Error("docker inspect returned incomplete image identity")
    return { key: expected[0], name: expected[1], imageReference: parsed.imageReference, immutableImageId: parsed.immutableImageId, startedAtUtc: parsed.startedAtUtc, running: true, health: "healthy" }
  })
}

async function capturePublicSnapshot(): Promise<TunnelPublicSnapshot> {
  const requestNonce = randomBytes(16).toString("hex")
  const observedAtUtc = new Date().toISOString()
  const [apiHealth, retainedArtifact, ...sellerResults] = await Promise.all([
    captureResponse("https://knot-api.truematchx.com/health", requestNonce, 131_072),
    captureResponse(artifactUrl, requestNonce, 1_048_576),
    ...expectedPublicSellers.map(async (seller) => {
      const [agentCard, domainRegistration, unauthenticatedInvocation] = await Promise.all([
        captureResponse(`${seller.origin}/.well-known/agent-card.json`, requestNonce, 131_072),
        captureResponse(`${seller.origin}/.well-known/agent-registration.json`, requestNonce, 131_072),
        captureUnauthenticated(`${seller.origin}/`, requestNonce),
      ])
      return { key: seller.key, agentId: seller.agentId, agentCard, domainRegistration, unauthenticatedInvocation }
    }),
  ])
  const snapshot = {
    requestNonce,
    observedAtUtc,
    completedAtUtc: new Date().toISOString(),
    apiHealth,
    sellers: sellerResults,
    retainedArtifact: { sellerKey: "healthguard" as const, expectedSha256: artifactSha256, response: retainedArtifact },
  }
  verifyTunnelPublicSnapshot(snapshot)
  return snapshot
}

async function captureResponse(canonicalUrl: string, nonce: string, maxBytes: number): Promise<CapturedResponse> {
  const url = withNonce(canonicalUrl, nonce)
  const started = performance.now()
  const result = await safeFetch(url, { headers: { accept: "application/json" }, maxBytes, maxRedirects: 0, timeoutMs: requestTimeoutMs })
  const latencyMs = Math.max(1, Math.ceil(performance.now() - started))
  if (result.status !== 200) throw new Error(`${canonicalUrl} returned HTTP ${result.status}`)
  const bytes = Buffer.from(result.body)
  return { url, httpStatus: 200, latencyMs, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, bodyBase64: bytes.toString("base64") }
}

async function captureUnauthenticated(canonicalUrl: string, nonce: string) {
  const url = withNonce(canonicalUrl, nonce)
  const started = performance.now()
  const result = await safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `tunnel-recovery-${nonce}`, method: "message/send", params: {} }),
    maxBytes: 65_536,
    maxRedirects: 0,
    timeoutMs: requestTimeoutMs,
  })
  const latencyMs = Math.max(1, Math.ceil(performance.now() - started))
  if (result.status !== 401) throw new Error(`${canonicalUrl} did not fail closed`)
  return { url, httpStatus: 401 as const, latencyMs }
}

async function remote(args: readonly string[], timeoutMs: number): Promise<string> {
  const command = args.map(shellQuote).join(" ")
  return await new Promise((resolveRemote, rejectRemote) => {
    const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", invocation.sshHost, command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) rejectRemote(new Error("bounded SSH command did not complete successfully"))
      else resolveRemote(stdout.trim())
    })
    child.stdin?.end()
  })
}

function withNonce(canonicalUrl: string, nonce: string): string {
  const url = new URL(canonicalUrl)
  url.searchParams.set("tunnel-recovery", nonce)
  return url.toString()
}

function assertContainersUnchanged(before: ContainerSnapshot[], after: ContainerSnapshot[]): void {
  for (const [index, prior] of before.entries()) {
    const current = after[index]
    if (current === undefined || current.key !== prior.key || current.immutableImageId !== prior.immutableImageId || current.startedAtUtc !== prior.startedAtUtc) throw new Error("a KNOT seller container changed during tunnel recovery")
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)
  if (value === undefined || value === "") throw new Error(`systemd omitted ${key}`)
  return value
}

function exact<const Value extends string>(values: ReadonlyMap<string, string>, key: string, expected: Value): Value {
  if (required(values, key) !== expected) throw new Error(`systemd ${key} is not ${expected}`)
  return expected
}

function unsignedInteger(values: ReadonlyMap<string, string>, key: string): number {
  const value = Number(required(values, key))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`systemd ${key} is not an unsigned integer`)
  return value
}

function positiveInteger(values: ReadonlyMap<string, string>, key: string): number {
  const value = unsignedInteger(values, key)
  if (value === 0) throw new Error(`systemd ${key} is not positive`)
  return value
}

function restartPolicy(value: string): ServiceSnapshot["restartPolicy"] {
  const allowed: ServiceSnapshot["restartPolicy"][] = ["on-success", "on-failure", "on-abnormal", "on-watchdog", "on-abort", "always", "debug"]
  if (!allowed.includes(value as ServiceSnapshot["restartPolicy"])) throw new Error("cloudflared has no accepted restart policy")
  return value as ServiceSnapshot["restartPolicy"]
}

function remainingMs(deadlineAt: number): number {
  const value = deadlineAt - Date.now()
  if (value <= 0) throw new Error("tunnel recovery deadline elapsed")
  return value
}
