import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem"
import { bsc } from "viem/chains"
import type { ShieldBlock, ShieldChainReader } from "./collector.ts"

export class ViemShieldChainReader implements ShieldChainReader {
  readonly sourceUri: string
  private readonly client: PublicClient

  constructor(client: PublicClient, sourceUri: string) {
    this.client = client
    this.sourceUri = sourceUri
  }

  getHeadBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  async getBlock(blockNumber: bigint): Promise<ShieldBlock> {
    const block = await this.client.getBlock({ blockNumber })
    if (block.hash === null) throw new Error("requested block has no hash")
    return { number: block.number, hash: block.hash, timestamp: block.timestamp }
  }

  async getBytecode(address: Address, blockNumber: bigint): Promise<Hex | null> {
    return (await this.client.getBytecode({ address, blockNumber })) ?? null
  }

  async getStorageAt(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | null> {
    return (await this.client.getStorageAt({ address, slot, blockNumber })) ?? null
  }
}

export function createBscShieldReader(rpcUrl: string): ViemShieldChainReader {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 20_000 }) }) as PublicClient
  return new ViemShieldChainReader(client, rpcUrl)
}
