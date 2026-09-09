import assert from "node:assert/strict"
import test from "node:test"
import type { Address, Hash, Hex } from "viem"
import { resolveTestnetSdkSource, TESTNET_CODE_SNAPSHOT } from "../../packages/commerce/src/deployments.ts"
import {
  collectBscTestnetErc8004Identity,
  Erc8004IdentityError,
  type Erc8004IdentityBlock,
  type Erc8004IdentityErrorCode,
  type Erc8004IdentityReader,
} from "../../packages/chain/src/erc8004-identity.ts"
import { ERC1967_IMPLEMENTATION_SLOT, TESTNET } from "../../packages/chain/src/manifest.ts"

const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
const registry = deployment.registry.toLowerCase() as Address
const implementation = deployment.registryImplementation.toLowerCase() as Address
const owner = "0x1111111111111111111111111111111111111111"
const wallet = "0x2222222222222222222222222222222222222222"
const blockHash = `0x${"a".repeat(64)}` as Hash
const otherHash = `0x${"b".repeat(64)}` as Hash
const blockTimestamp = 1_788_940_800n
const now = new Date(Number(blockTimestamp + 10n) * 1_000)
const implementationWord = `0x${"0".repeat(24)}${implementation.slice(2)}` as Hex
const tokenURI = "data:application/json;base64,eyJuYW1lIjoiS05PVCJ9"

class FixtureReader implements Erc8004IdentityReader {
  readonly sourceUri: string
  readonly observedBlocks: bigint[] = []
  readonly observedAgentIds: bigint[] = []
  readonly observedRegistries: Address[] = []
  chainId = 97
  head = 108n
  returnedBlockNumber: bigint | null = null
  initialBlockHash: Hash = blockHash
  finalBlockHash: Hash = blockHash
  timestamp = blockTimestamp
  proxyHash: Hash | null = TESTNET_CODE_SNAPSHOT.hashes.registry
  implementationHash: Hash | null = TESTNET_CODE_SNAPSHOT.hashes.registryImplementation
  ownerCodeHash: Hash | null = null
  implementationSlot: Hex | null = implementationWord
  owner: Address = owner
  wallet: Address = wallet
  uri = tokenURI
  rejectOperation: string | null = null
  private blockReads = 0

  constructor(sourceUri: string) {
    this.sourceUri = sourceUri
  }

  async getChainId(): Promise<number> {
    this.reject("chain")
    return this.chainId
  }

  async getHeadBlockNumber(): Promise<bigint> {
    this.reject("head")
    return this.head
  }

  async getBlock(blockNumber: bigint): Promise<Erc8004IdentityBlock> {
    this.reject("block")
    this.observedBlocks.push(blockNumber)
    this.blockReads += 1
    return {
      number: this.returnedBlockNumber ?? blockNumber,
      hash: this.blockReads > 1 ? this.finalBlockHash : this.initialBlockHash,
      timestamp: this.timestamp,
    }
  }

  async getCodeHash(address: Address, blockNumber: bigint): Promise<Hash | null> {
    this.reject("code")
    this.observedBlocks.push(blockNumber)
    if (address.toLowerCase() === registry) return this.proxyHash
    if (address.toLowerCase() === implementation) return this.implementationHash
    return this.ownerCodeHash
  }

  async getStorageAt(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | null> {
    this.reject("storage")
    this.observedBlocks.push(blockNumber)
    assert.equal(address, registry)
    assert.equal(slot, ERC1967_IMPLEMENTATION_SLOT)
    return this.implementationSlot
  }

  async ownerOf(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address> {
    this.reject("owner")
    this.recordIdentityRead(registryAddress, agentId, blockNumber)
    return this.owner
  }

  async getAgentWallet(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address> {
    this.reject("wallet")
    this.recordIdentityRead(registryAddress, agentId, blockNumber)
    return this.wallet
  }

  async tokenURI(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<string> {
    this.reject("uri")
    this.recordIdentityRead(registryAddress, agentId, blockNumber)
    return this.uri
  }

  private recordIdentityRead(registryAddress: Address, agentId: bigint, blockNumber: bigint): void {
    this.observedBlocks.push(blockNumber)
    this.observedAgentIds.push(agentId)
    this.observedRegistries.push(registryAddress)
  }

  private reject(operation: string): void {
    if (this.rejectOperation === operation) throw new Error("fixture read failed")
  }
}

function fixtures(): [FixtureReader, FixtureReader] {
  const first = new FixtureReader(TESTNET.rpcUrls[0]!)
  const second = new FixtureReader(TESTNET.rpcUrls[1]!)
  second.head = 110n
  return [first, second]
}

function collect(readers = fixtures(), agentId = 2295n) {
  return collectBscTestnetErc8004Identity(readers, agentId, () => now)
}

async function rejectsCode(promise: Promise<unknown>, code: Erc8004IdentityErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Erc8004IdentityError)
    assert.equal(error.code, code)
    return true
  })
}

test("observes one deployment-pinned identity at the shared confirmed block", async () => {
  const [first, second] = fixtures()
  const observed = await collect([second, first])
  assert.equal(observed.schemaVersion, "knot.erc8004-identity-observation/1")
  assert.equal(observed.status, "VERIFIED")
  assert.equal(observed.chainId, 97)
  assert.equal(observed.registry, registry)
  assert.equal(observed.agentId, "2295")
  assert.equal(observed.owner, owner)
  assert.equal(observed.ownerAccountType, "EOA")
  assert.equal(observed.agentWallet, wallet)
  assert.equal(observed.tokenURI, tokenURI)
  assert.equal(observed.blockNumber, "105")
  assert.equal(observed.blockHash, blockHash)
  assert.equal(observed.confirmationDepth, 3)
  assert.deepEqual(observed.rpcSources, TESTNET.rpcUrls)
  assert.deepEqual(observed.registryDeployment, {
    proxyCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registry,
    implementation,
    implementationCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registryImplementation,
  })
  for (const reader of [first, second]) {
    assert.ok(reader.observedBlocks.length >= 7)
    assert.ok(reader.observedBlocks.every((value) => value === 105n))
    assert.ok(reader.observedAgentIds.every((value) => value === 2295n))
    assert.ok(reader.observedRegistries.every((value) => value === registry))
  }
})

test("rejects invalid reader, chain, head, agent, and block freshness boundaries", async (context) => {
  await context.test("unpinned reader", async () => {
    const pair = fixtures()
    const unpinned = new FixtureReader("https://example.com")
    await rejectsCode(collect([pair[0], unpinned]), "CONFIGURATION_MISMATCH")
  })
  await context.test("wrong chain", async () => {
    const pair = fixtures()
    pair[1].chainId = 56
    await rejectsCode(collect(pair), "CONFIGURATION_MISMATCH")
  })
  await context.test("insufficient head", async () => {
    const pair = fixtures()
    pair[0].head = 2n
    await rejectsCode(collect(pair), "UPSTREAM_UNAVAILABLE")
  })
  await context.test("negative agent", async () => rejectsCode(collect(fixtures(), -1n), "CONFIGURATION_MISMATCH"))
  await context.test("stale block", async () => {
    const pair = fixtures()
    pair[0].timestamp -= 31n
    pair[1].timestamp = pair[0].timestamp
    await rejectsCode(collect(pair), "STALE_BLOCK")
  })
  await context.test("future block", async () => {
    const pair = fixtures()
    pair[0].timestamp += 16n
    pair[1].timestamp = pair[0].timestamp
    await rejectsCode(collect(pair), "UPSTREAM_UNAVAILABLE")
  })
})

test("rejects every selected-block and deployment disagreement", async (context) => {
  await context.test("wrong block number", async () => {
    const pair = fixtures()
    pair[1].returnedBlockNumber = 104n
    await rejectsCode(collect(pair), "RPC_DISAGREEMENT")
  })
  await context.test("block hash", async () => {
    const pair = fixtures()
    pair[1].initialBlockHash = otherHash
    await rejectsCode(collect(pair), "RPC_DISAGREEMENT")
  })
  await context.test("block timestamp", async () => {
    const pair = fixtures()
    pair[1].timestamp += 1n
    await rejectsCode(collect(pair), "RPC_DISAGREEMENT")
  })
  await context.test("proxy code hash", async () => {
    const pair = fixtures()
    pair[1].proxyHash = otherHash
    await rejectsCode(collect(pair), "DEPLOYMENT_MISMATCH")
  })
  await context.test("implementation slot", async () => {
    const pair = fixtures()
    pair[0].implementationSlot = `0x${"0".repeat(64)}`
    await rejectsCode(collect(pair), "DEPLOYMENT_MISMATCH")
  })
  await context.test("implementation code hash", async () => {
    const pair = fixtures()
    pair[0].implementationHash = otherHash
    await rejectsCode(collect(pair), "DEPLOYMENT_MISMATCH")
  })
})

test("rejects identity disagreement, absent identity, reverts, and hash drift", async (context) => {
  const disagreements: Array<[string, (reader: FixtureReader) => void]> = [
    ["owner", (reader) => { reader.owner = "0x3333333333333333333333333333333333333333" }],
    ["wallet", (reader) => { reader.wallet = "0x4444444444444444444444444444444444444444" }],
    ["token URI", (reader) => { reader.uri = `${tokenURI}x` }],
  ]
  for (const [name, mutate] of disagreements) {
    await context.test(name, async () => {
      const pair = fixtures()
      mutate(pair[1])
      await rejectsCode(collect(pair), "RPC_DISAGREEMENT")
    })
  }
  await context.test("zero owner", async () => {
    const pair = fixtures()
    pair[0].owner = "0x0000000000000000000000000000000000000000"
    pair[1].owner = pair[0].owner
    await rejectsCode(collect(pair), "IDENTITY_MISMATCH")
  })
  await context.test("empty token URI", async () => {
    const pair = fixtures()
    pair[0].uri = ""
    pair[1].uri = ""
    await rejectsCode(collect(pair), "IDENTITY_MISMATCH")
  })
  await context.test("oversized token URI", async () => {
    const pair = fixtures()
    pair[0].uri = "x".repeat(8_193)
    pair[1].uri = pair[0].uri
    await rejectsCode(collect(pair), "IDENTITY_MISMATCH")
  })
  await context.test("contract owner", async () => {
    const pair = fixtures()
    pair[1].ownerCodeHash = otherHash
    await rejectsCode(collect(pair), "IDENTITY_MISMATCH")
  })
  await context.test("owner read revert", async () => {
    const pair = fixtures()
    pair[0].rejectOperation = "owner"
    await rejectsCode(collect(pair), "UPSTREAM_UNAVAILABLE")
  })
  await context.test("block hash drift", async () => {
    const pair = fixtures()
    pair[1].finalBlockHash = otherHash
    await rejectsCode(collect(pair), "RPC_DISAGREEMENT")
  })
  await context.test("agreed block hash drift", async () => {
    const pair = fixtures()
    pair[0].finalBlockHash = otherHash
    pair[1].finalBlockHash = otherHash
    await rejectsCode(collect(pair), "ORPHANED_OBSERVATION")
  })
})
