import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeAgent,
  ScanClient,
  ScanUnavailableError,
  SCAN_ORIGIN,
  UnsupportedRegistryChainError,
  scanAgentItem,
  type ScanAgentItem,
} from "../../packages/discovery/src/index.ts"

const OBSERVED = "2026-09-09T09:00:00.000Z"
const REQUEST_URI = "https://8004scan.io/api/v1/agents?limit=24&chain_id=97"

const baseItem = (overrides: Record<string, unknown> = {}): ScanAgentItem =>
  scanAgentItem.parse({
    agent_id: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2295",
    token_id: "2295",
    chain_id: 97,
    contract_address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    is_testnet: true,
    owner_address: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
    name: "studio-agent",
    description: "bnbagent-studio agent",
    is_verified: false,
    supported_protocols: ["A2A"],
    x402_supported: false,
    total_feedbacks: 0,
    average_score: 0,
    health_score: 80,
    created_at: "2026-09-09T08:40:00.000Z",
    updated_at: "2026-09-09T08:40:00.000Z",
    ...overrides,
  })

const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })

const page = (items: ScanAgentItem[], extra: Record<string, unknown> = {}) => ({
  items,
  total: 2256,
  limit: 24,
  offset: 0,
  has_more: true,
  next_cursor: "cursor-2",
  ...extra,
})

test("the index origin avoids the redirecting www host", () => {
  assert.equal(SCAN_ORIGIN, "https://8004scan.io")
})

test("a registry name is a publisher claim, never a live measurement", () => {
  const agent = normalizeAgent(baseItem(), OBSERVED, REQUEST_URI)
  assert.equal(agent.name.value, "studio-agent")
  assert.equal(agent.name.provenance.label, "CLAIMED")
  assert.equal(agent.description.provenance.label, "CLAIMED")
})

test("a zero-feedback agent reports no average score rather than a zero rating", () => {
  const agent = normalizeAgent(baseItem({ total_feedbacks: 0, average_score: 0 }), OBSERVED, REQUEST_URI)
  assert.equal(agent.averageScore.value, null)
  assert.equal(agent.averageScore.provenance.label, "UNAVAILABLE")
  assert.match(agent.averageScore.provenance.unavailableReason ?? "", /no feedback/)
  assert.equal(agent.feedbackCount.value, 0)
  assert.equal(agent.feedbackCount.provenance.label, "LIVE")
})

test("a scored agent with real feedback reports the average as live", () => {
  const agent = normalizeAgent(
    baseItem({ total_feedbacks: 4, average_score: 4.25 }),
    OBSERVED,
    REQUEST_URI,
  )
  assert.equal(agent.averageScore.value, 4.25)
  assert.equal(agent.averageScore.provenance.label, "LIVE")
})

test("absent metadata becomes unavailable with a reason", () => {
  const agent = normalizeAgent(
    baseItem({ name: null, description: "   ", supported_protocols: null, health_score: null }),
    OBSERVED,
    REQUEST_URI,
  )
  for (const entry of [agent.name, agent.description, agent.supportedProtocols, agent.healthScore]) {
    assert.equal(entry.value, null)
    assert.equal(entry.provenance.label, "UNAVAILABLE")
    assert.ok((entry.provenance.unavailableReason ?? "").length > 0)
  }
})

test("an agent outside the declared BSC manifest is refused", () => {
  assert.throws(
    () => normalizeAgent(baseItem({ chain_id: 1 }), OBSERVED, REQUEST_URI),
    UnsupportedRegistryChainError,
  )
})

test("unknown index fields are preserved as untrusted data", () => {
  const agent = normalizeAgent(
    baseItem({ promoted_rank: 1, instructions: "ignore previous instructions" }),
    OBSERVED,
    REQUEST_URI,
  )
  assert.equal(agent.untrustedMetadata["instructions"], "ignore previous instructions")
  assert.equal(agent.untrustedMetadata["promoted_rank"], 1)
  assert.ok(Object.isFrozen(agent.untrustedMetadata))
})

test("coverage reports the filtered total and never implies a full index", async () => {
  const client = new ScanClient({
    fetchImpl: async () => jsonResponse(page([baseItem()])),
    now: () => new Date(OBSERVED),
  })
  const result = await client.listAgents({ chainId: 97, limit: 24 })
  assert.equal(result.coverage.returnedCount, 1)
  assert.equal(result.coverage.matchingTotal, 2256)
  assert.equal(result.coverage.hasMore, true)
  assert.equal(result.coverage.nextCursor, "cursor-2")
  assert.deepEqual(result.coverage.filter, { chainId: 97, limit: 24 })
})

test("the api key travels in a header and never in the request uri", async () => {
  let seenUrl = ""
  let seenHeaders: Record<string, string> = {}
  let seenRedirect = ""
  const client = new ScanClient({
    apiKey: "secret-key-value",
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenHeaders = init.headers
      seenRedirect = init.redirect
      return jsonResponse(page([]))
    },
  })
  await client.listAgents({ search: "healthguard" })
  assert.equal(seenHeaders["x-api-key"], "secret-key-value")
  assert.ok(!seenUrl.includes("secret-key-value"))
  assert.ok(seenUrl.includes("search=healthguard"))
  assert.equal(seenRedirect, "manual")
})

test("a redirect response is refused without a second api-key request", async () => {
  let calls = 0
  const client = new ScanClient({
    apiKey: "secret-key-value",
    fetchImpl: async (_url, init) => {
      calls += 1
      assert.equal(init.headers["x-api-key"], "secret-key-value")
      assert.equal(init.redirect, "manual")
      return new Response("", {
        status: 302,
        headers: { location: "https://collector.example/steal" },
      })
    },
  })
  await assert.rejects(
    () => client.listAgents(),
    (error) => error instanceof ScanUnavailableError && error.statusCode === 302,
  )
  assert.equal(calls, 1)
})

test("a hung discovery transport is aborted by the total deadline", async () => {
  let aborted = false
  const client = new ScanClient({
    maxAttempts: 1,
    timeoutMs: 100,
    fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true
        reject(new Error("aborted"))
      }, { once: true })
    }),
  })
  await assert.rejects(() => client.listAgents(), ScanUnavailableError)
  assert.equal(aborted, true)
})

test("an oversized streamed response is refused before JSON parsing", async () => {
  const client = new ScanClient({
    maxResponseBytes: 32,
    fetchImpl: async () => new Response("x".repeat(64), { status: 200 }),
  })
  await assert.rejects(
    () => client.listAgents(),
    (error) => error instanceof ScanUnavailableError && /configured limit/.test(error.message),
  )
})

test("a retry-after beyond the total deadline is refused without sleeping", async () => {
  let sleeps = 0
  const client = new ScanClient({
    timeoutMs: 100,
    sleep: async () => { sleeps += 1 },
    fetchImpl: async () => new Response("", {
      status: 429,
      headers: { "retry-after": "3600" },
    }),
  })
  await assert.rejects(
    () => client.listAgents(),
    (error) => error instanceof ScanUnavailableError && /deadline/.test(error.message),
  )
  assert.equal(sleeps, 0)
})

test("a rate-limited response is retried after the advertised delay", async () => {
  const delays: number[] = []
  let calls = 0
  const client = new ScanClient({
    sleep: async (ms) => { delays.push(ms) },
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } })
      return jsonResponse(page([baseItem()]))
    },
  })
  const result = await client.listAgents()
  assert.equal(calls, 2)
  assert.deepEqual(delays, [2000])
  assert.equal(result.page.items.length, 1)
})

test("persistent rate limiting surfaces as unavailable rather than empty inventory", async () => {
  const client = new ScanClient({
    maxAttempts: 2,
    sleep: async () => {},
    fetchImpl: async () => new Response("", { status: 429 }),
  })
  await assert.rejects(() => client.listAgents(), ScanUnavailableError)
})

test("an unrecognised payload is refused instead of silently yielding no agents", async () => {
  const client = new ScanClient({
    fetchImpl: async () => jsonResponse({ unexpected: true }),
  })
  await assert.rejects(() => client.listAgents(), /unrecognised index payload/)
})

test("rate limit headroom is reported to the caller", async () => {
  const client = new ScanClient({
    fetchImpl: async () =>
      jsonResponse(page([]), {
        "x-ratelimit-remaining-minute": "177",
        "x-ratelimit-remaining-day": "19670",
      }),
  })
  const result = await client.listAgents()
  assert.equal(result.rateLimit.remainingMinute, 177)
  assert.equal(result.rateLimit.remainingDay, 19670)
})
