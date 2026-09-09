import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  loadOwnedSellerConfig,
  OwnedSellerConfigError,
} from "../../apps/api/src/owned-seller-config.ts"

const keys = ["healthguard", "rangepilot", "gridquant", "yieldscout"] as const

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: "true",
    KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID: "health-client",
    KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET: "health-secret-0001",
    KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID: "range-client",
    KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET: "range-secret-00001",
    KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_ID: "grid-client",
    KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET: "grid-secret-000001",
    KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_ID: "yield-client",
    KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET: "yield-secret-00001",
  }
}

function expectConfigurationError(source: NodeJS.ProcessEnv, forbiddenValue?: string): void {
  assert.throws(() => loadOwnedSellerConfig(source), (error: unknown) => {
    assert.ok(error instanceof OwnedSellerConfigError)
    if (forbiddenValue !== undefined) assert.equal(error.message.includes(forbiddenValue), false)
    return true
  })
}

describe("owned seller credential configuration", () => {
  test("defaults to disabled and does not require or inspect credentials", () => {
    const absent = loadOwnedSellerConfig({})
    const disabled = loadOwnedSellerConfig({
      KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: "false",
      KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET: "invalid\nvalue",
    })
    assert.deepEqual(absent, { enabled: false })
    assert.equal(disabled, absent)
    assert.ok(Object.isFrozen(disabled))
  })

  test("accepts only the closed true and false flag values", () => {
    for (const value of ["TRUE", "False", "1", "yes", " true "]) {
      assert.throws(
        () => loadOwnedSellerConfig({ KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: value }),
        {
          name: "OwnedSellerConfigError",
          message: "KNOT_OWNED_SELLER_NEGOTIATION_ENABLED must be true or false",
        },
      )
    }
  })

  test("returns all four credential pairs under sealed seller keys", () => {
    const config = loadOwnedSellerConfig(enabledEnvironment())
    assert.equal(config.enabled, true)
    if (!config.enabled) assert.fail("configuration must be enabled")
    assert.deepEqual(Object.keys(config.credentials), keys)
    assert.deepEqual(config.credentials.rangepilot, {
      clientId: "range-client",
      clientSecret: "range-secret-00001",
    })
    assert.ok(Object.isFrozen(config))
    assert.ok(Object.isFrozen(config.credentials))
    assert.ok(Object.values(config.credentials).every((item) => Object.isFrozen(item)))
  })

  test("rejects missing, oversized, short, and non-printable credentials without reflecting values", () => {
    const cases: Array<[string, string | undefined]> = [
      ["KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID", undefined],
      ["KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID", "x".repeat(257)],
      ["KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID", "client\nidentifier"],
      ["KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET", "short"],
      ["KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET", "x".repeat(4_097)],
      ["KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET", "yield-secret-000\u007f"],
    ]
    for (const [key, value] of cases) {
      const source = enabledEnvironment()
      source[key] = value
      expectConfigurationError(source, value)
    }
  })

  test("requires four distinct secrets and separation from API authentication", () => {
    const duplicate = enabledEnvironment()
    const duplicateValue = duplicate.KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET!
    duplicate.KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET = duplicateValue
    expectConfigurationError(duplicate, duplicateValue)

    const shared = enabledEnvironment()
    const sharedValue = shared.KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET!
    shared.KNOT_API_AUTH_TOKEN = sharedValue
    expectConfigurationError(shared, sharedValue)
  })

  test("ignores environment attempts to supply authority or routing fields", () => {
    const source = enabledEnvironment()
    source.KNOT_OWNED_SELLER_HEALTHGUARD_ENDPOINT = "https://attacker.invalid"
    source.KNOT_OWNED_SELLER_RANGEPILOT_SCOPE = "attacker:invoke"
    source.KNOT_OWNED_SELLER_GRIDQUANT_REGISTRY = "0x0000000000000000000000000000000000000000"
    source.KNOT_OWNED_SELLER_YIELDSCOUT_AGENT_ID = "1"
    source.KNOT_OWNED_SELLER_HEALTHGUARD_OWNER = "0x0000000000000000000000000000000000000000"
    source.KNOT_OWNED_SELLER_COMMERCE = "0x0000000000000000000000000000000000000000"
    source.KNOT_OWNED_SELLER_TOKEN = "0x0000000000000000000000000000000000000000"
    const config = loadOwnedSellerConfig(source)
    assert.equal(config.enabled, true)
    if (!config.enabled) assert.fail("configuration must be enabled")
    assert.deepEqual(Object.keys(config.credentials), keys)
    assert.ok(Object.values(config.credentials).every((item) => Object.keys(item).join(",") === "clientId,clientSecret"))
  })
})
