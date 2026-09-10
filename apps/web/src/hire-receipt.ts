import { createPublicClient, http, type Hex, type TransactionReceipt } from "viem"
import { bscTestnet } from "viem/chains"
import type { ConfirmedReceipt } from "./hire-types.ts"

const client = createPublicClient({ chain: bscTestnet, transport: http("https://bsc-testnet-rpc.publicnode.com", { timeout: 15_000, retryCount: 1 }) })

export interface ReceiptRpc {
  getChainId(): Promise<number>
  getBlockNumber(options: { cacheTime: number }): Promise<bigint>
  getTransactionReceipt(options: { hash: Hex }): Promise<Pick<TransactionReceipt, "transactionHash" | "status" | "blockNumber" | "blockHash" | "logs">>
  getBlock(options: { blockNumber: bigint }): Promise<{ hash: string | null }>
  getTransaction(options: { hash: Hex }): Promise<{ hash: string; from: string; to: string | null; input: string; value: bigint; chainId?: number | undefined; blockHash: string | null }>
}

export async function readReceiptFrom(client: ReceiptRpc, hash: string): Promise<ConfirmedReceipt | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash.")
  if (await client.getChainId() !== 97) throw new Error("Receipt RPC is not on BSC testnet.")
  const transactionHash = hash as `0x${string}`
  const receipt = await client.getTransactionReceipt({ hash: transactionHash })
  const head = await client.getBlockNumber({ cacheTime: 0 })
  if (head < receipt.blockNumber + 1n) return null
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash !== receipt.blockHash) throw new Error("Receipt block is no longer canonical.")
  const tx = await client.getTransaction({ hash: transactionHash })
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || tx.blockHash !== receipt.blockHash || tx.chainId !== 97) throw new Error("Transaction and receipt disagree.")
  return {
    status: receipt.status, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(),
    logs: receipt.logs.map(log => ({ address: log.address, data: log.data, topics: log.topics })),
    transaction: { from: tx.from, to: tx.to, input: tx.input, value: tx.value.toString(), chainId: tx.chainId },
  }
}

export const readTestnetReceipt = (hash: string): Promise<ConfirmedReceipt | null> => readReceiptFrom(client, hash)
