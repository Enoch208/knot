import { createPublicClient, http, keccak256, parseAbi, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { bscTestnet } from "viem/chains"
import { TESTNET } from "./manifest.ts"
import type { Erc8004IdentityBlock, Erc8004IdentityReader } from "./erc8004-identity.ts"

const registryAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
])

export class ViemErc8004IdentityReader implements Erc8004IdentityReader {
  readonly sourceUri: string
  private readonly client: PublicClient

  constructor(client: PublicClient, sourceUri: string) {
    this.client = client
    this.sourceUri = validatedSourceUri(sourceUri)
  }

  getChainId(): Promise<number> {
    return this.client.getChainId()
  }

  getHeadBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  async getBlock(blockNumber: bigint): Promise<Erc8004IdentityBlock> {
    const block = await this.client.getBlock({ blockNumber })
    if (block.hash === null) throw new Error("Block hash unavailable")
    return { number: block.number, hash: block.hash, timestamp: block.timestamp }
  }

  async getCodeHash(address: Address, blockNumber: bigint): Promise<Hash | null> {
    const code = await this.client.getCode({ address, blockNumber })
    return code === undefined || code === "0x" ? null : keccak256(code)
  }

  async getStorageAt(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | null> {
    return (await this.client.getStorageAt({ address, slot, blockNumber })) ?? null
  }

  ownerOf(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address> {
    return this.client.readContract({
      address: registryAddress,
      abi: registryAbi,
      functionName: "ownerOf",
      args: [agentId],
      blockNumber,
    })
  }

  getAgentWallet(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address> {
    return this.client.readContract({
      address: registryAddress,
      abi: registryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
      blockNumber,
    })
  }

  tokenURI(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<string> {
    return this.client.readContract({
      address: registryAddress,
      abi: registryAbi,
      functionName: "tokenURI",
      args: [agentId],
      blockNumber,
    })
  }
}

export function createViemBscTestnetErc8004IdentityReaders(
  timeoutMilliseconds = 10_000,
): readonly [ViemErc8004IdentityReader, ViemErc8004IdentityReader] {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 60_000) {
    throw new RangeError("RPC timeout is outside its supported range")
  }
  const first = TESTNET.rpcUrls[0]
  const second = TESTNET.rpcUrls[1]
  if (first === undefined || second === undefined || TESTNET.rpcUrls.length !== 2) {
    throw new Error("BSC testnet requires exactly two pinned RPC URLs")
  }
  return [createReader(first, timeoutMilliseconds), createReader(second, timeoutMilliseconds)]
}

function createReader(sourceUri: string, timeoutMilliseconds: number): ViemErc8004IdentityReader {
  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(sourceUri, { retryCount: 0, timeout: timeoutMilliseconds }),
  })
  return new ViemErc8004IdentityReader(client, sourceUri)
}

function validatedSourceUri(sourceUri: string): string {
  const parsed = new URL(sourceUri)
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("RPC source must be credential-free HTTPS")
  }
  return parsed.toString().replace(/\/$/, "")
}
