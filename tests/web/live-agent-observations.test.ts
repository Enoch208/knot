import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { observeAgentEndpoint, observeAgentEndpoints } from "../../apps/web/src/live-agent-observations.ts"

const profile = { slug: "rangepilot" as const, endpoint: "https://agent.example" }

describe("live marketplace endpoint observations", () => {
  it("requires both the agent card and domain proof for a fully available state", async () => {
    const requested: string[] = []
    let tick = 100
    const observation = await observeAgentEndpoint(profile, {
      fetcher: async (input) => {
        requested.push(String(input))
        return new Response("{}", { status: 200 })
      },
      now: () => (tick += 23),
      checkedAt: () => new Date("2026-09-13T12:00:00.000Z"),
    })

    assert.equal(observation.state, "AVAILABLE")
    assert.equal(observation.latencyMs, 23)
    assert.equal(observation.checkedAtUtc, "2026-09-13T12:00:00.000Z")
    assert.deepEqual(requested.sort(), [
      "https://agent.example/.well-known/agent-card.json",
      "https://agent.example/.well-known/agent-registration.json",
    ])
  })

  it("reports partial state rather than treating one successful document as live", async () => {
    const observation = await observeAgentEndpoint(profile, {
      fetcher: async (input) => new Response("{}", {
        status: String(input).endsWith("agent-card.json") ? 200 : 503,
      }),
    })
    assert.equal(observation.state, "DEGRADED")
    assert.equal(observation.cardAvailable, true)
    assert.equal(observation.proofAvailable, false)
  })

  it("fails closed when both observations reject", async () => {
    const observation = await observeAgentEndpoint(profile, {
      fetcher: async () => { throw new Error("offline") },
    })
    assert.equal(observation.state, "UNAVAILABLE")
    assert.equal(observation.latencyMs, null)
  })

  it("checks every configured endpoint without converting failures into empty coverage", async () => {
    const observations = await observeAgentEndpoints([
      profile,
      { slug: "healthguard", endpoint: "https://health.example" },
    ], {
      fetcher: async (input) => new Response("{}", {
        status: String(input).includes("health.example") ? 503 : 200,
      }),
    })
    assert.deepEqual(observations.map(({ slug, state }) => ({ slug, state })), [
      { slug: "rangepilot", state: "AVAILABLE" },
      { slug: "healthguard", state: "UNAVAILABLE" },
    ])
  })
})
