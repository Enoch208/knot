import assert from "node:assert/strict"
import { test } from "node:test"
import { getAddress } from "viem"
import type {
  CommerceCompatibility,
  CommerceProbeReader,
} from "../../packages/commerce/src/index.ts"
import {
  commerceCompatibilitySuspensions,
  permitsNetworkWrites,
  probeTestnetCommerce,
} from "../../scripts/verify-manifest.ts"

const unavailable = async (): Promise<never> => {
  throw new Error("injected RPC failure")
}

const unavailableReader = (): CommerceProbeReader => ({
  chainId: unavailable,
  blockNumber: unavailable,
  codeHash: unavailable,
  implementation: unavailable,
  routerCommerce: unavailable,
  routerPaused: unavailable,
  policyWhitelisted: unavailable,
  paymentToken: unavailable,
  policyCommerce: unavailable,
  policyRouter: unavailable,
  disputeWindow: unavailable,
})

test("manifest commerce probing uses the supplied RPC reader and fails closed", async () => {
  const rpcUrl = "https://rpc.invalid.example"
  let observedRpcUrl: string | null = null
  const compatibility = await probeTestnetCommerce(
    rpcUrl,
    "2026-09-09T10:00:00Z",
    (candidate) => {
      observedRpcUrl = candidate
      return unavailableReader()
    },
  )
  assert.equal(observedRpcUrl, rpcUrl)
  assert.equal(compatibility.status, "UNRESOLVED")
  assert.equal(compatibility.writeAllowed, false)
  assert.match(compatibility.reasons.join(" "), /injected RPC failure/)
  assert.equal(permitsNetworkWrites(true, compatibility, []), false)
  assert.deepEqual(
    commerceCompatibilitySuspensions(compatibility),
    compatibility.reasons.map((reason) => `commerce: ${reason}`),
  )
})

test("reader construction failure suspends writes", async () => {
  const compatibility = await probeTestnetCommerce(
    "https://rpc.invalid.example",
    "2026-09-09T10:00:00Z",
    () => {
      throw new Error("reader construction failed")
    },
  )
  assert.equal(compatibility.writeAllowed, false)
  assert.match(compatibility.reasons.join(" "), /reader construction failed/)
})

test("write permission requires a successful commerce probe and no suspensions", () => {
  const compatibility: CommerceCompatibility = {
    status: "VERIFIED",
    writeAllowed: true,
    chainId: 97,
    blockNumber: "129987120",
    observedAtUtc: "2026-09-09T10:00:00Z",
    sdkVersions: {
      "@altananetwork/sdk": "0.7.1",
      "@bnbagent/sdk": "0.5.5",
    },
    selectedPolicy: getAddress("0xd6a4217588f6b1f5657a92a3e94e6422ad771cea"),
    declarationConflict: true,
    reasons: [],
    policies: [],
  }
  assert.equal(permitsNetworkWrites(true, compatibility, []), true)
  assert.equal(permitsNetworkWrites(true, compatibility, ["router drift"]), false)
  assert.equal(permitsNetworkWrites(false, compatibility, []), false)
  assert.equal(permitsNetworkWrites(true, null, []), false)
  assert.deepEqual(
    commerceCompatibilitySuspensions(null),
    ["commerce: compatibility probe unavailable"],
  )
  assert.equal(
    permitsNetworkWrites(true, { ...compatibility, status: "UNRESOLVED" }, []),
    false,
  )
  assert.equal(
    permitsNetworkWrites(true, { ...compatibility, selectedPolicy: null }, []),
    false,
  )
})
