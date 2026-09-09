import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test from "node:test"

const secret = "unit-test-api-token-that-must-never-appear"
const allowedOrigin = "https://demo.knot.example"

test("verified quote demo runner proves the quote-only path and exact retry", async () => {
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "")
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    assert.equal(request.headers.origin, allowedOrigin)
    await drain(request)
    const id = "demo-range-quote-unit-positive"
    reply(response, paths.length === 4 ? 200 : 201, paths.length >= 3 ? quote(id, "demo-range-unit-positive", false) : {})
  })
  const result = await run(server, "unit-positive")
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(paths, [
    "/api/tasks",
    "/api/tasks/demo-range-unit-positive/service-requests",
    "/api/service-requests/demo-range-quote-unit-positive/verified-quotes",
    "/api/service-requests/demo-range-quote-unit-positive/verified-quotes",
  ])
  const evidence = JSON.parse(result.stdout) as {
    mode: string
    api: {
      origin: string
      taskStatus: number
      serviceRequestStatus: number
      quoteStatus: number
      idempotentRetryStatus: number
    }
    boundary: { fundingPermitted: boolean; chainWritePerformed: boolean; mainnetWritePerformed: boolean }
  }
  assert.equal(evidence.mode, "QUOTE_ONLY")
  assert.deepEqual(evidence.api, {
    origin: evidence.api.origin,
    taskStatus: 201,
    serviceRequestStatus: 201,
    quoteStatus: 201,
    idempotentRetryStatus: 200,
  })
  assert.equal(evidence.boundary.fundingPermitted, false)
  assert.equal(evidence.boundary.chainWritePerformed, false)
  assert.equal(evidence.boundary.mainnetWritePerformed, false)
  assert.equal(result.stdout.includes(secret), false)
})

test("verified quote demo runner rejects a funding-capable response without leaking authority", async () => {
  let count = 0
  const server = createServer(async (request, response) => {
    count += 1
    await drain(request)
    const id = "demo-range-quote-unit-adversarial"
    reply(response, 201, count >= 3 ? quote(id, "demo-range-unit-adversarial", true) : {})
  })
  const result = await run(server, "unit-adversarial")
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /invalid verified quote response/)
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false)
})

async function run(server: ReturnType<typeof createServer>, runId: string) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server address is unavailable")
  const child = spawn(process.execPath, ["scripts/run-verified-quote-demo.ts", runId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KNOT_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      KNOT_API_AUTH_TOKEN: secret,
      KNOT_API_ALLOWED_ORIGIN: allowedOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value })
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value })
  const [code] = await once(child, "exit") as [number | null]
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return { code, stdout, stderr }
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) void _chunk
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function quote(id: string, taskId: string, fundingPermitted: boolean): Record<string, unknown> {
  return {
    stage: "VERIFIED_PRE_FUNDING",
    id,
    taskId,
    negotiationHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    fundingPermitted,
  }
}
