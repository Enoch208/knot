import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"
import { parseSellerRecoveryDrillInvocation, verifySellerRecoveryEvidence } from "../packages/reliability/src/seller-recovery.ts"

const execute = promisify(execFile)
const invocation = parseSellerRecoveryDrillInvocation(process.argv.slice(2), process.env)
const target = invocation.sshHost
const outputPath = invocation.outputPath
await mkdir(dirname(outputPath), { recursive: true })
const outputReservation = await open(outputPath, "wx", 0o600)
const expectedContract = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de"
const sellers = [
  { key: "healthguard", category: "health", hostname: "knot-health.truematchx.com", agentId: "2295", container: "knot-healthguard-agent-1", requestPath: ".secrets/buyer/health-negotiate-observation.json", artifactUrl: "https://knot-artifacts.truematchx.com/knot-deliverables/healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json", artifactSha256: "581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2" },
  { key: "rangepilot", category: "rebalancing", hostname: "knot-range.truematchx.com", agentId: "2297", container: "knot-rangepilot-agent-1", requestPath: ".secrets/buyer/analysis-paid/rangepilot-negotiate-observation.json", artifactUrl: "https://knot-artifacts.truematchx.com/knot-deliverables/rangepilot/sha256/ca13ae8a177a33a5180762ceaca2faa8bf8415d14079e52980fb5bec3130432a.json", artifactSha256: "ca13ae8a177a33a5180762ceaca2faa8bf8415d14079e52980fb5bec3130432a" },
  { key: "gridquant", category: "grid", hostname: "knot-grid.truematchx.com", agentId: "2298", container: "knot-gridquant-agent-1", requestPath: ".secrets/buyer/analysis-paid/gridquant-negotiate-observation.json", artifactUrl: "https://knot-artifacts.truematchx.com/knot-deliverables/gridquant/sha256/0a8f485757cdc3308e95e944362e2be73d966b2a7309da437abc8f9e04adf152.json", artifactSha256: "0a8f485757cdc3308e95e944362e2be73d966b2a7309da437abc8f9e04adf152" },
  { key: "yieldscout", category: "yield", hostname: "knot-yield.truematchx.com", agentId: "2299", container: "knot-yieldscout-agent-1", requestPath: ".secrets/buyer/analysis-paid/yieldscout-negotiate-observation.json", artifactUrl: "https://knot-artifacts.truematchx.com/knot-deliverables/yieldscout/sha256/c3fbb46a4df2110bf3d3f9dfa5c101d5488c0b0c6cd0c4afbc62103cc550edd9.json", artifactSha256: "c3fbb46a4df2110bf3d3f9dfa5c101d5488c0b0c6cd0c4afbc62103cc550edd9" },
] as const

const quoteProgram = 'let raw="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>raw+=c);process.stdin.on("end",async()=>{try{const form=new URLSearchParams({grant_type:"client_credentials",client_id:process.env.KNOT_AGENT_OAUTH_CLIENT_ID,client_secret:process.env.KNOT_AGENT_OAUTH_CLIENT_SECRET,scope:process.env.OAUTH_SCOPE});const tr=await fetch(process.env.OAUTH_TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form});const token=await tr.json();if(!tr.ok||typeof token.access_token!=="string")throw new Error("token rejected");const rr=await fetch("http://127.0.0.1:9000/",{method:"POST",headers:{authorization:"Bearer "+token.access_token,"content-type":"application/json"},body:raw});const out=await rr.json();const data=out?.result?.parts?.[0]?.data;process.stdout.write(JSON.stringify({tokenHttpStatus:tr.status,invocationHttpStatus:rr.status,accepted:data?.response?.accepted===true,providerSignaturePresent:typeof data?.provider_sig==="string"&&/^0x[0-9a-fA-F]{130}$/.test(data.provider_sig),chainId:data?.chain_id,verifyingContract:data?.verifying_contract}));}catch(error){process.stderr.write(error instanceof Error?error.message:String(error));process.exit(1)}})'

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const remote = async (args: string[], input?: string): Promise<string> => {
  const command = args.map(shellQuote).join(" ")
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, command], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`remote command failed with ${code}: ${stderr.trim()}`)))
    child.stdin.end(input)
  })
}

type Inspect = {
  imageId: string
  imageReference: string
  startedAtUtc: string
  health: string
  restartPolicy: string
  readOnlyRootFilesystem: boolean
  capDrop: string[]
  securityOpt: string[]
}

const inspect = async (container: string): Promise<Inspect> => {
  const format = '{"imageId":"{{.Image}}","imageReference":"{{.Config.Image}}","startedAtUtc":"{{.State.StartedAt}}","health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}","restartPolicy":"{{.HostConfig.RestartPolicy.Name}}","readOnlyRootFilesystem":{{.HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}'
  return JSON.parse(await remote(["docker", "inspect", "--format", format, container])) as Inspect
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const curl = async (args: string[]): Promise<{ body: Buffer; status: number }> => {
  const marker = Buffer.from("\nKNOT_HTTP_STATUS:")
  const result = await execute("curl", ["--silent", "--show-error", "--max-time", "20", ...args, "--write-out", "\nKNOT_HTTP_STATUS:%{http_code}"], { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 })
  const separator = result.stdout.lastIndexOf(marker)
  if (separator < 0) throw new Error("curl response did not include a status")
  return { body: result.stdout.subarray(0, separator), status: Number(result.stdout.subarray(separator + marker.length).toString("ascii")) }
}

const fetchResource = async (url: string, nonce: string) => {
  const separator = url.includes("?") ? "&" : "?"
  const response = await curl([`${url}${separator}recovery=${nonce}`])
  if (response.status !== 200) throw new Error(`${url} returned ${response.status}`)
  return { url, httpStatus: 200 as const, sha256: sha256(response.body), byteLength: response.body.byteLength }
}

const publicSurface = async (seller: typeof sellers[number], nonce: string) => {
  const origin = `https://${seller.hostname}`
  const [agentCard, domainRegistration, retained] = await Promise.all([
    fetchResource(`${origin}/.well-known/agent-card.json`, nonce),
    fetchResource(`${origin}/.well-known/agent-registration.json`, nonce),
    fetchResource(seller.artifactUrl, nonce),
  ])
  const unauthenticated = await curl(["--request", "POST", "--header", "content-type: application/json", "--data-binary", JSON.stringify({ jsonrpc: "2.0", id: `recovery-${nonce}`, method: "message/send", params: {} }), `${origin}/`])
  if (unauthenticated.status !== 401) throw new Error(`${seller.key} unauthenticated invocation returned ${unauthenticated.status}`)
  return { agentCard, domainRegistration, unauthenticatedInvocationHttpStatus: 401 as const, retainedArtifact: { ...retained, expectedSha256: seller.artifactSha256 } }
}

const waitForRecovery = async (seller: typeof sellers[number], deadline: number): Promise<Inspect> => {
  while (Date.now() < deadline) {
    try {
      const state = await inspect(seller.container)
      if (state.health === "healthy") return state
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`${seller.key} did not become healthy before the deadline`)
}

const readRequest = async (path: string): Promise<string> => {
  const observation: unknown = JSON.parse(await readFile(path, "utf8"))
  if (typeof observation !== "object" || observation === null || !("request" in observation)) throw new Error(`missing request in ${path}`)
  return JSON.stringify(observation.request)
}

const gitCommit = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim()
const results = []
for (const seller of sellers) {
  const before = await inspect(seller.container)
  if (before.health !== "healthy") throw new Error(`${seller.key} was not healthy before restart`)
  const publicSurfaceBefore = await publicSurface(seller, `${Date.now()}-before`)
  const restartRequestedAtUtc = new Date().toISOString()
  await remote(["docker", "restart", "--time", "20", seller.container])
  const restartCommandCompletedAtUtc = new Date().toISOString()
  const after = await waitForRecovery(seller, Date.now() + 90_000)
  const publicSurfaceAfter = await publicSurface(seller, `${Date.now()}-after`)
  const authenticatedQuoteAfter = JSON.parse(await remote(["docker", "exec", "-i", seller.container, "node", "-e", quoteProgram], await readRequest(seller.requestPath))) as Record<string, unknown>
  if (authenticatedQuoteAfter.verifyingContract !== expectedContract) throw new Error(`${seller.key} quote contract mismatch`)
  const recoveredAtUtc = new Date().toISOString()
  results.push({
    key: seller.key,
    category: seller.category,
    hostname: seller.hostname,
    agentId: seller.agentId,
    image: { reference: before.imageReference, immutableIdBefore: before.imageId, immutableIdAfter: after.imageId, unchanged: before.imageId === after.imageId },
    container: { startedAtBeforeUtc: before.startedAtUtc, startedAtAfterUtc: after.startedAtUtc, healthBefore: before.health, healthAfter: after.health, restartPolicy: after.restartPolicy, readOnlyRootFilesystem: after.readOnlyRootFilesystem, capDropAll: after.capDrop.includes("ALL"), noNewPrivileges: after.securityOpt.includes("no-new-privileges:true") },
    timing: { restartRequestedAtUtc, restartCommandCompletedAtUtc, recoveredAtUtc, recoveryDurationMs: Date.parse(recoveredAtUtc) - Date.parse(restartRequestedAtUtc) },
    publicSurfaceBefore,
    publicSurfaceAfter,
    authenticatedQuoteAfter,
  })
  process.stderr.write(`${seller.key} recovered\n`)
}

const evidence = verifySellerRecoveryEvidence({
  schemaVersion: "knot.seller-recovery-evidence/1",
  observedAtUtc: new Date().toISOString(),
  gitCommit,
  drill: { mode: "sequential-container-restart", command: "npm run reliability:drill -- --execute", serverRole: "KNOT seller VPS" },
  boundary: { onlyStateChangingOperation: "seller-container-restart", dockerDaemonRestarted: false, vpsRestarted: false, cloudflaredRestarted: false, networkTrafficInstrumented: false, commerceMutationCommands: 0, mainnetWriteCommands: 0, fundTransferCommands: 0 },
  sellers: results,
  limitations: ["One controlled restart was measured per seller.", "The VPS, Docker daemon, Cloudflare tunnel, object store, and database were not restarted.", "No concurrent-load, regional-availability, uptime, SLA, or host-failure claim is made.", "Authenticated recovery proves the quote-response path only; the drill issued no commerce mutation, mainnet-write, or fund-transfer command.", "Network traffic was not instrumented, so no claim is made about every background chain read.", "Quote checks replay retained negotiate requests and establish service recovery, not current input freshness or new commerce."],
})
await outputReservation.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8" })
await outputReservation.sync()
await outputReservation.close()
process.stdout.write(`${outputPath}\n`)
