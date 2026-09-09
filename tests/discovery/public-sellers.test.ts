import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  BSC_TESTNET_ERC8004_REGISTRY,
  expectedPublicSellers,
  resolveOwnedSellerAuthority,
  verifyPublicSeller,
  type ExpectedPublicSeller,
  type PublicSellerHttpReader,
} from "../../packages/discovery/src/public-sellers.ts"

const expected = expectedPublicSellers[1]!

describe("sealed owned-seller authority", () => {
  test("binds every owned seller to one TaskSpec category and registry identity", () => {
    assert.deepEqual(expectedPublicSellers.map(({ key, category, origin, oauthScope, registry, agentId, owner }) => ({
      key,
      category,
      origin,
      oauthScope,
      registry,
      agentId,
      owner,
    })), [
      {
        key: "healthguard",
        category: "health",
        origin: "https://knot-health.truematchx.com",
        oauthScope: "knot:healthguard:invoke",
        registry: BSC_TESTNET_ERC8004_REGISTRY,
        agentId: 2295,
        owner: "0xaf7474d06f171e6fd72fc5af114b34f3d5af8389",
      },
      {
        key: "rangepilot",
        category: "rebalancing",
        origin: "https://knot-range.truematchx.com",
        oauthScope: "knot:rangepilot:invoke",
        registry: BSC_TESTNET_ERC8004_REGISTRY,
        agentId: 2297,
        owner: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
      },
      {
        key: "gridquant",
        category: "grid",
        origin: "https://knot-grid.truematchx.com",
        oauthScope: "knot:gridquant:invoke",
        registry: BSC_TESTNET_ERC8004_REGISTRY,
        agentId: 2298,
        owner: "0x3d5355a97352f4d078016342ad117a5e88d5c74f",
      },
      {
        key: "yieldscout",
        category: "yield",
        origin: "https://knot-yield.truematchx.com",
        oauthScope: "knot:yieldscout:invoke",
        registry: BSC_TESTNET_ERC8004_REGISTRY,
        agentId: 2299,
        owner: "0x6fd04720c7fccb6dcebf6cf08dd6f5c764c7d8e3",
      },
    ])
    assert.ok(Object.isFrozen(expectedPublicSellers))
    assert.ok(expectedPublicSellers.every((seller) => Object.isFrozen(seller)))
  })

  test("resolves only the exact origin with an optional single root slash", () => {
    for (const seller of expectedPublicSellers) {
      assert.equal(resolveOwnedSellerAuthority(seller.category, seller.origin), seller)
      assert.equal(resolveOwnedSellerAuthority(seller.category, `${seller.origin}/`), seller)
    }
  })

  test("rejects endpoint transformations instead of URL-normalizing them into authority", () => {
    const rejected = [
      "http://knot-range.truematchx.com",
      "https://user@knot-range.truematchx.com",
      "https://knot-range.truematchx.com:443",
      "https://knot-range.truematchx.com:8443",
      "https://knot-range.truematchx.com/path",
      "https://knot-range.truematchx.com//",
      "https://knot-range.truematchx.com?mode=test",
      "https://knot-range.truematchx.com/?mode=test",
      "https://knot-range.truematchx.com#fragment",
      "https://knot-range.truematchx.com.attacker.invalid",
      "https://knot-range.truematchx.com@attacker.invalid",
      "https://KNOT-RANGE.TRUEMATCHX.COM",
      " https://knot-range.truematchx.com",
    ]
    for (const endpoint of rejected) {
      assert.equal(resolveOwnedSellerAuthority("rebalancing", endpoint), null, endpoint)
    }
  })

  test("rejects category mismatch and the unsupported security category", () => {
    assert.equal(resolveOwnedSellerAuthority("health", expected.origin), null)
    assert.equal(resolveOwnedSellerAuthority("security", expected.origin), null)
  })
})

function validCard(item: ExpectedPublicSeller): unknown {
  return {
    name: item.cardName,
    description: "bounded analysis seller",
    url: `${item.origin}/`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "negotiate" }, { id: "notify_funded" }],
    securitySchemes: {
      oauth2: {
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: `${item.origin}/oauth/token`,
            scopes: { [item.oauthScope]: "Invoke the seller" },
          },
        },
      },
    },
    security: [{ oauth2: [item.oauthScope] }],
  }
}

function reader(overrides: {
  card?: unknown
  proof?: unknown
  cardStatus?: number
  proofStatus?: number
  unauthenticatedStatus?: number
} = {}): PublicSellerHttpReader {
  return {
    async getJson(url) {
      if (url.endsWith("agent-card.json")) {
        return { status: overrides.cardStatus ?? 200, body: overrides.card ?? validCard(expected) }
      }
      return {
        status: overrides.proofStatus ?? 200,
        body: overrides.proof ?? {
          registrations: [{
            agentId: expected.agentId,
            agentRegistry: "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e",
          }],
        },
      }
    },
    async postUnauthenticated() {
      return overrides.unauthenticatedStatus ?? 401
    },
  }
}

describe("public seller release verification", () => {
  test("verifies the card, OAuth boundary, unauthenticated refusal, and domain identity together", async () => {
    const result = await verifyPublicSeller(reader(), expected)
    assert.deepEqual(result, {
      key: "rangepilot",
      outcome: "VERIFIED",
      cardStatus: 200,
      registrationStatus: 200,
      unauthenticatedInvokeStatus: 401,
      errors: [],
    })
  })

  test("rejects a same-looking card whose OAuth endpoint crosses origins", async () => {
    const changed = validCard(expected) as { securitySchemes: { oauth2: { flows: { clientCredentials: { tokenUrl: string } } } } }
    changed.securitySchemes.oauth2.flows.clientCredentials.tokenUrl = "https://attacker.invalid/oauth/token"
    const result = await verifyPublicSeller(reader({ card: changed }), expected)
    assert.equal(result.outcome, "MISMATCH")
    assert.match(result.errors.join(" "), /not same-origin/)
  })

  test("rejects a proof for another chain-97 identity", async () => {
    const result = await verifyPublicSeller(reader({
      proof: {
        registrations: [{
          agentId: expected.agentId + 1,
          agentRegistry: "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        }],
      },
    }), expected)
    assert.equal(result.outcome, "MISMATCH")
    assert.match(result.errors.join(" "), /does not bind/)
  })

  test("requires a 401 unauthenticated boundary and both commerce skills", async () => {
    const changed = validCard(expected) as { skills: Array<{ id: string }> }
    changed.skills = [{ id: "negotiate" }]
    const result = await verifyPublicSeller(reader({ card: changed, unauthenticatedStatus: 200 }), expected)
    assert.equal(result.outcome, "MISMATCH")
    assert.match(result.errors.join(" "), /HTTP 200/)
    assert.match(result.errors.join(" "), /commerce skills/)
  })

  test("collapses transport failures to unavailable without leaking an exception", async () => {
    const failing: PublicSellerHttpReader = {
      async getJson() {
        throw new Error("private resolver detail")
      },
      async postUnauthenticated() {
        throw new Error("private resolver detail")
      },
    }
    const result = await verifyPublicSeller(failing, expected)
    assert.equal(result.outcome, "UNAVAILABLE")
    assert.doesNotMatch(result.errors.join(" "), /private resolver detail/)
  })
})
