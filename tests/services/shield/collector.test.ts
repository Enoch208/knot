import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { keccak256, type Address, type Hash, type Hex } from "viem"
import {
  collectShieldSnapshot,
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  ShieldCollectionError,
  type ShieldBlock,
  type ShieldChainReader,
} from "../../../packages/services/shield/index.ts"

const NOW = new Date("2026-09-09T12:00:00.000Z")
const TARGET = "0x1111111111111111111111111111111111111111"
const IMPLEMENTATION = "0x2222222222222222222222222222222222222222"
const ADMIN = "0x3333333333333333333333333333333333333333"
const BLOCK_HASH = `0x${"a".repeat(64)}` as Hash
const BYTECODE = "0x6001600055" as Hex

function storageWord(address: string): Hex {
  return `0x${"0".repeat(24)}${address.slice(2)}`
}

class FixtureReader implements ShieldChainReader {
  readonly sourceUri = "fixture://bsc"
  head = 100n
  firstHash = BLOCK_HASH
  secondHash = BLOCK_HASH
  bytecode: Hex | null = BYTECODE
  blockTimestamp = 1_788_955_190n
  storage = new Map<Hex, Hex | null>([
    [ERC1967_IMPLEMENTATION_SLOT, storageWord(IMPLEMENTATION)],
    [ERC1967_ADMIN_SLOT, storageWord(ADMIN)],
    [ERC1967_BEACON_SLOT, "0x0"],
  ])
  blockReads = 0
  failingSlot: Hex | null = null

  async getHeadBlockNumber(): Promise<bigint> {
    return this.head
  }

  async getBlock(blockNumber: bigint): Promise<ShieldBlock> {
    this.blockReads += 1
    return {
      number: blockNumber,
      hash: this.blockReads === 1 ? this.firstHash : this.secondHash,
      timestamp: this.blockTimestamp,
    }
  }

  async getBytecode(_address: Address, _blockNumber: bigint): Promise<Hex | null> {
    return this.bytecode
  }

  async getStorageAt(_address: Address, slot: Hex, _blockNumber: bigint): Promise<Hex | null> {
    if (slot === this.failingSlot) throw new Error("private upstream detail")
    return this.storage.get(slot) ?? null
  }
}

describe("Shield pinned BSC snapshot collection", () => {
  test("hashes runtime code and decodes ERC-1967 slots at one verified block", async () => {
    const reader = new FixtureReader()
    const snapshot = await collectShieldSnapshot(reader, {
      targetAddress: TARGET,
      confirmationBlocks: 5n,
      maxBlockAgeSeconds: 60,
      now: NOW,
    })
    assert.equal(snapshot.blockNumber, "95")
    assert.equal(snapshot.blockHash, BLOCK_HASH)
    assert.equal(snapshot.runtimeBytecode.status, "available")
    if (snapshot.runtimeBytecode.status === "available") {
      assert.equal(snapshot.runtimeBytecode.codeHash, keccak256(BYTECODE))
      assert.equal(snapshot.runtimeBytecode.sizeBytes, 5)
    }
    assert.equal(snapshot.proxySlots.implementation.status, "value")
    assert.equal(snapshot.proxySlots.implementation.value, IMPLEMENTATION)
    assert.equal(snapshot.proxySlots.admin.status, "value")
    assert.equal(snapshot.proxySlots.admin.value, ADMIN)
    assert.equal(snapshot.proxySlots.beacon.status, "empty")
    assert.equal(snapshot.verifiedSource.status, "unavailable")
    assert.equal(reader.blockReads, 2)
  })

  test("retains failed storage reads as unresolved evidence without leaking an upstream error", async () => {
    const reader = new FixtureReader()
    reader.failingSlot = ERC1967_ADMIN_SLOT
    const snapshot = await collectShieldSnapshot(reader, { targetAddress: TARGET, now: NOW })
    assert.equal(snapshot.proxySlots.admin.status, "unreadable")
    if (snapshot.proxySlots.admin.status === "unreadable") {
      assert.equal(snapshot.proxySlots.admin.reason, "the pinned storage read failed")
      assert.doesNotMatch(snapshot.proxySlots.admin.reason, /private upstream detail/)
    }
  })

  test("records missing runtime bytecode as unavailable rather than a zero-size contract", async () => {
    const reader = new FixtureReader()
    reader.bytecode = null
    const snapshot = await collectShieldSnapshot(reader, { targetAddress: TARGET, now: NOW })
    assert.deepEqual(snapshot.runtimeBytecode, {
      status: "unavailable",
      reason: "no runtime bytecode exists at the target and pinned block",
    })
  })

  test("rejects a block hash change during the read set", async () => {
    const reader = new FixtureReader()
    reader.secondHash = `0x${"b".repeat(64)}`
    await assert.rejects(
      collectShieldSnapshot(reader, { targetAddress: TARGET, now: NOW }),
      (error: unknown) => error instanceof ShieldCollectionError && error.code === "ORPHANED_SNAPSHOT",
    )
  })

  test("rejects stale blocks and invalid collection limits", async () => {
    const stale = new FixtureReader()
    stale.blockTimestamp -= 3_600n
    await assert.rejects(
      collectShieldSnapshot(stale, { targetAddress: TARGET, now: NOW }),
      (error: unknown) => error instanceof ShieldCollectionError && error.code === "STALE_SNAPSHOT",
    )

    const invalid = new FixtureReader()
    await assert.rejects(
      collectShieldSnapshot(invalid, { targetAddress: TARGET, confirmationBlocks: -1n, now: NOW }),
      (error: unknown) => error instanceof ShieldCollectionError && error.code === "INVALID_CONFIGURATION",
    )
  })
})
