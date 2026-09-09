import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem"
import {
  prepareHire,
  requireCommerceWriteReady,
  TESTNET_CODE_SNAPSHOT,
  TESTNET_SDK_SOURCES,
  verifyTestnetCommerce,
  type CommerceProbeReader,
} from "../../packages/commerce/src/index.ts"

const [altana, bnbAgent] = TESTNET_SDK_SOURCES
const selected = bnbAgent.deployment.policy

class FixtureReader implements CommerceProbeReader {
  chain = 97
  block = TESTNET_CODE_SNAPSHOT.blockNumber
  paused = false
  fail = false
  whitelist = new Set([selected.toLowerCase()])
  policyCommerceOverride = new Map<string, Address>()
  implementations = new Map<string, Address>([
    [bnbAgent.deployment.commerce.toLowerCase(), bnbAgent.deployment.commerceImplementation],
    [bnbAgent.deployment.router.toLowerCase(), bnbAgent.deployment.routerImplementation],
    [bnbAgent.deployment.registry.toLowerCase(), bnbAgent.deployment.registryImplementation],
  ])
  codeHashes = new Map<string, Hex>([
    [bnbAgent.deployment.commerce.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.commerce],
    [bnbAgent.deployment.commerceImplementation.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.commerceImplementation],
    [bnbAgent.deployment.router.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.router],
    [bnbAgent.deployment.routerImplementation.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.routerImplementation],
    [bnbAgent.deployment.registry.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.registry],
    [bnbAgent.deployment.registryImplementation.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.registryImplementation],
    [bnbAgent.deployment.paymentToken.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.paymentToken],
    [altana.deployment.policy.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.altanaPolicy],
    [bnbAgent.deployment.policy.toLowerCase(), TESTNET_CODE_SNAPSHOT.hashes.bnbAgentPolicy],
  ])

  async chainId(): Promise<number> {
    if (this.fail) throw new Error("RPC unavailable")
    return this.chain
  }
  async blockNumber(): Promise<bigint> {
    return this.block
  }
  async codeHash(address: Address): Promise<Hex | null> {
    return this.codeHashes.get(address.toLowerCase()) ?? null
  }
  async implementation(address: Address): Promise<Address | null> {
    return this.implementations.get(address.toLowerCase()) ?? null
  }
  async routerCommerce(): Promise<Address> {
    return bnbAgent.deployment.commerce
  }
  async routerPaused(): Promise<boolean> {
    return this.paused
  }
  async policyWhitelisted(_router: Address, policy: Address): Promise<boolean> {
    return this.whitelist.has(policy.toLowerCase())
  }
  async paymentToken(): Promise<Address> {
    return bnbAgent.deployment.paymentToken
  }
  async policyCommerce(policy: Address): Promise<Address> {
    return this.policyCommerceOverride.get(policy.toLowerCase()) ?? bnbAgent.deployment.commerce
  }
  async policyRouter(): Promise<Address> {
    return bnbAgent.deployment.router
  }
  async disputeWindow(policy: Address): Promise<bigint> {
    return policy.toLowerCase() === selected.toLowerCase() ? 900n : 86400n
  }
}

const fixture = (): FixtureReader => {
  return new FixtureReader()
}

test("the live-whitelisted BNB Agent policy resolves the SDK declaration conflict", async () => {
  const reader = fixture()
  const observation = await verifyTestnetCommerce(reader, "2026-09-09T08:00:00Z")
  assert.equal(observation.declarationConflict, true)
  assert.equal(observation.status, "VERIFIED")
  assert.equal(observation.selectedPolicy, getAddress(selected))
  assert.equal(requireCommerceWriteReady(observation), getAddress(selected))
})

test("a wrong chain suspends writes", async () => {
  const reader = fixture()
  reader.chain = 56
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.throws(() => requireCommerceWriteReady(observation), /RPC chain 56/)
})

test("zero whitelisted compatible policies suspends writes", async () => {
  const reader = fixture()
  reader.whitelist.clear()
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons.join(" "), /observed 0/)
})

test("ambiguous live policies suspend writes", async () => {
  const reader = fixture()
  reader.whitelist.add(altana.deployment.policy.toLowerCase())
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons.join(" "), /observed 2/)
})

test("a policy bound to another commerce kernel is rejected", async () => {
  const reader = fixture()
  reader.policyCommerceOverride.set(selected.toLowerCase(), getAddress("0x1111111111111111111111111111111111111111"))
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.equal(observation.policies.find((policy) => policy.address === selected)?.compatible, false)
})

test("bytecode drift suspends writes", async () => {
  const reader = fixture()
  reader.codeHashes.set(bnbAgent.deployment.routerImplementation.toLowerCase(), `0x${"1".repeat(64)}`)
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons.join(" "), /router implementation bytecode/)
})

test("proxy implementation drift suspends writes", async () => {
  const reader = fixture()
  reader.implementations.set(
    bnbAgent.deployment.commerce.toLowerCase(),
    getAddress("0x2222222222222222222222222222222222222222"),
  )
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons.join(" "), /commerce proxy implementation/)
})

test("a paused router suspends writes", async () => {
  const reader = fixture()
  reader.paused = true
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons.join(" "), /router is paused/)
})

test("RPC failure becomes an unresolved observation", async () => {
  const reader = fixture()
  reader.fail = true
  const observation = await verifyTestnetCommerce(reader)
  assert.equal(observation.status, "UNRESOLVED")
  assert.equal(observation.writeAllowed, false)
  assert.match(observation.reasons[0] ?? "", /RPC unavailable/)
})

test("hire preparation binds the only live compatible policy", async () => {
  const observation = await verifyTestnetCommerce(fixture())
  const calls = prepareHire(observation, {
    jobId: 1174n,
    provider: getAddress("0x3333333333333333333333333333333333333333"),
    description: "knot.task/1",
    budget: 100000000000000000n,
    expiredAt: 1002000n,
    nowSeconds: 1000000n,
  })
  assert.equal(calls.length, 5)
  const registration = calls[1]
  assert.ok(registration)
  assert.ok(registration.data)
  const decoded = decodeFunctionData({
    abi: [{ type: "function", name: "registerJob", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [] }],
    data: registration.data,
  })
  assert.deepEqual(decoded.args, [1174n, selected])
})

test("hire preparation refuses an expiry that cannot clear the dispute window", async () => {
  const observation = await verifyTestnetCommerce(fixture())
  assert.throws(
    () =>
      prepareHire(observation, {
        jobId: 1174n,
        provider: getAddress("0x3333333333333333333333333333333333333333"),
        description: "knot.task/1",
        budget: 100000000000000000n,
        expiredAt: 1000900n,
        nowSeconds: 1000000n,
      }),
    /expiredAt must exceed/,
  )
})
