import assert from "node:assert/strict"
import test from "node:test"
import { keccak256, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { TESTNET } from "../../packages/chain/src/manifest.ts"
import {
  createViemBscTestnetErc8004IdentityReaders,
  ViemErc8004IdentityReader,
} from "../../packages/chain/src/erc8004-identity-viem.ts"

const registry = "0x1111111111111111111111111111111111111111"
const owner = "0x2222222222222222222222222222222222222222"
const wallet = "0x3333333333333333333333333333333333333333"
const blockHash = `0x${"a".repeat(64)}` as Hash
const slot = `0x${"b".repeat(64)}` as Hex
const word = `0x${"c".repeat(64)}` as Hex
const code = "0x60006000" as Hex

interface CapturedCall {
  operation: string
  blockNumber?: bigint
  address?: Address
  functionName?: string
  args?: readonly unknown[]
}

function fixtureClient(calls: CapturedCall[]): PublicClient {
  return {
    getChainId: async () => 97,
    getBlockNumber: async () => 108n,
    getBlock: async (request: { blockNumber: bigint }) => {
      calls.push({ operation: "block", blockNumber: request.blockNumber })
      return { number: request.blockNumber, hash: blockHash, timestamp: 1_788_940_800n }
    },
    getCode: async (request: { address: Address; blockNumber: bigint }) => {
      calls.push({ operation: "code", address: request.address, blockNumber: request.blockNumber })
      return code
    },
    getStorageAt: async (request: { address: Address; blockNumber: bigint }) => {
      calls.push({ operation: "storage", address: request.address, blockNumber: request.blockNumber })
      return word
    },
    readContract: async (request: {
      address: Address
      functionName: string
      args: readonly unknown[]
      blockNumber: bigint
    }) => {
      calls.push({
        operation: "contract",
        address: request.address,
        functionName: request.functionName,
        args: request.args,
        blockNumber: request.blockNumber,
      })
      if (request.functionName === "ownerOf") return owner
      if (request.functionName === "getAgentWallet") return wallet
      return "data:application/json;base64,e30="
    },
  } as unknown as PublicClient
}

test("viem adapter pins every state read to the requested block", async () => {
  const calls: CapturedCall[] = []
  const reader = new ViemErc8004IdentityReader(fixtureClient(calls), TESTNET.rpcUrls[0]!)
  assert.equal(await reader.getChainId(), 97)
  assert.equal(await reader.getHeadBlockNumber(), 108n)
  assert.deepEqual(await reader.getBlock(105n), { number: 105n, hash: blockHash, timestamp: 1_788_940_800n })
  assert.equal(await reader.getCodeHash(registry, 105n), keccak256(code))
  assert.equal(await reader.getStorageAt(registry, slot, 105n), word)
  assert.equal(await reader.ownerOf(registry, 2295n, 105n), owner)
  assert.equal(await reader.getAgentWallet(registry, 2295n, 105n), wallet)
  assert.equal(await reader.tokenURI(registry, 2295n, 105n), "data:application/json;base64,e30=")
  assert.ok(calls.every((call) => call.blockNumber === 105n))
  assert.deepEqual(calls.filter((call) => call.operation === "contract").map((call) => call.functionName), [
    "ownerOf",
    "getAgentWallet",
    "tokenURI",
  ])
  assert.ok(calls.filter((call) => call.operation === "contract").every((call) => call.args?.[0] === 2295n))
})

test("adapter rejects unsafe sources and factory exposes only the pinned RPC pair", () => {
  const client = fixtureClient([])
  assert.throws(() => new ViemErc8004IdentityReader(client, "http://example.com"), /credential-free HTTPS/)
  assert.throws(() => new ViemErc8004IdentityReader(client, "https://user:pass@example.com"), /credential-free HTTPS/)
  assert.throws(() => createViemBscTestnetErc8004IdentityReaders(99), /timeout/)
  const readers = createViemBscTestnetErc8004IdentityReaders()
  assert.deepEqual(readers.map((reader) => reader.sourceUri), TESTNET.rpcUrls)
})
