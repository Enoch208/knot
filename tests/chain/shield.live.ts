import assert from "node:assert/strict"
import test from "node:test"
import { collectShieldSnapshot, createBscShieldReader } from "../../packages/services/shield/index.ts"

const rpcUrl = process.env.KNOT_LIVE_SHIELD_RPC?.trim()

test(
  "captures a hash-pinned BSC mainnet bytecode and ERC-1967 snapshot",
  { skip: rpcUrl ? false : "KNOT_LIVE_SHIELD_RPC is required" },
  async () => {
    if (!rpcUrl) throw new Error("KNOT_LIVE_SHIELD_RPC is required")
    const reader = createBscShieldReader(rpcUrl)
    const snapshot = await collectShieldSnapshot(reader, {
      targetAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      confirmationBlocks: 5n,
      maxBlockAgeSeconds: 90,
    })
    assert.equal(snapshot.chainId, 56)
    assert.equal(snapshot.canonicality, "confirmed")
    assert.equal(snapshot.runtimeBytecode.status, "available")
    assert.equal(snapshot.proxySlots.implementation.status, "empty")
    assert.equal(snapshot.proxySlots.admin.status, "empty")
    assert.equal(snapshot.proxySlots.beacon.status, "empty")
  },
)
