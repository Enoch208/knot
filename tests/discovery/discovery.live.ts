import assert from "node:assert/strict"
import test from "node:test"
import { normalizeAgent, ScanClient } from "../../packages/discovery/src/index.ts"

const apiKey = process.env.KNOT_SCAN_API_KEY
const options = apiKey === undefined ? {} : { apiKey }

test("the live index returns normalizable BSC testnet inventory", async () => {
  const client = new ScanClient(options)
  const result = await client.listAgents({ chainId: 97, limit: 5 })

  assert.ok(result.coverage.matchingTotal > 0)
  assert.equal(result.coverage.returnedCount, result.page.items.length)
  assert.ok(result.coverage.returnedCount <= 5)

  for (const item of result.page.items) {
    const agent = normalizeAgent(item, result.coverage.observedAtUtc, result.coverage.requestUri)
    assert.equal(agent.key.chainId, 97)
    assert.equal(agent.isTestnet, true)
    if (agent.feedbackCount.value === 0) {
      assert.equal(agent.averageScore.provenance.label, "UNAVAILABLE")
    }
  }
})

test("the live index exposes a compatible third-party health-factor provider", async () => {
  const client = new ScanClient(options)
  const result = await client.listAgents({ chainId: 97, search: "health", limit: 25 })

  const normalized = result.page.items.map((item) =>
    normalizeAgent(item, result.coverage.observedAtUtc, result.coverage.requestUri),
  )
  const named = normalized.filter((agent) => agent.name.value !== null)
  assert.ok(named.length > 0, "expected at least one named health-factor agent in the live index")

  for (const agent of named) {
    assert.equal(agent.name.provenance.label, "CLAIMED")
  }
})

test("the live index discovers all four KNOT seller identities", async () => {
  const client = new ScanClient(options)
  const result = await client.listAgents({ chainId: 97, search: "KNOT", limit: 25 })
  const normalized = result.page.items.map((item) =>
    normalizeAgent(item, result.coverage.observedAtUtc, result.coverage.requestUri),
  )
  const byId = new Map(normalized.map((agent) => [agent.key.agentId, agent]))
  const expected = new Map([
    ["2295", "KNOT HealthGuard"],
    ["2297", "KNOT RangePilot"],
    ["2298", "KNOT GridQuant"],
    ["2299", "KNOT YieldScout"],
  ])
  for (const [agentId, name] of expected) {
    const agent = byId.get(agentId)
    assert.ok(agent, `expected KNOT agent ${agentId} in live discovery`)
    assert.equal(agent.name.value, name)
    assert.equal(agent.name.provenance.label, "CLAIMED")
    assert.equal(agent.key.chainId, 97)
  }
})

test("the live index reports remaining rate-limit headroom", async () => {
  const client = new ScanClient(options)
  const result = await client.listAgents({ chainId: 97, limit: 1 })
  assert.notEqual(result.rateLimit.remainingMinute, null)
  assert.ok((result.rateLimit.remainingMinute ?? 0) > 0)
})
