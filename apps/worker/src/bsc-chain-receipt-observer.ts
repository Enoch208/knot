import { keccak256, type Hex } from "viem"
import { z } from "zod"
import {
  canonicalEvmTransactionIntentJson,
  hashEvmTransactionIntent,
} from "../../../packages/chain/src/transaction-intent.ts"
import type { ChainActionRecord } from "../../../packages/db/src/chain-action-repository.ts"
import { safeFetch, validateSafeUrl } from "../../../packages/security/src/index.ts"
import type { ChainReceiptObservation, ChainReceiptObserver } from "./chain-action-reconciler.ts"

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
const calldata = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/)

const transaction = z.object({
  hash,
  from: address,
  to: address.nullable(),
  nonce: quantity,
  input: calldata,
  value: quantity,
  gas: quantity,
  gasPrice: quantity,
  type: quantity,
  chainId: quantity,
  blockNumber: quantity.nullable(),
  blockHash: hash.nullable(),
}).passthrough()

const receipt = z.object({
  transactionHash: hash,
  status: quantity,
  blockNumber: quantity,
  blockHash: hash,
}).passthrough()

const block = z.object({ number: quantity, hash }).passthrough()
const rpcEnvelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int().positive(),
  result: z.unknown(),
}).strict()

export type BscReadRpcMethod =
  | "eth_chainId"
  | "eth_getTransactionByHash"
  | "eth_getTransactionReceipt"
  | "eth_blockNumber"
  | "eth_getBlockByNumber"

export interface BscReadRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: BscReadRpcMethod
  params: readonly unknown[]
}

export interface BscReadRpcTransport {
  batch(url: string, requests: readonly BscReadRpcRequest[], signal: AbortSignal): Promise<unknown>
}

export class SafeBscReadRpcTransport implements BscReadRpcTransport {
  private readonly timeoutMilliseconds: number

  constructor(timeoutMilliseconds = 10_000) {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 60_000) {
      throw new RangeError("RPC timeout is outside its supported range")
    }
    this.timeoutMilliseconds = timeoutMilliseconds
  }

  async batch(url: string, requests: readonly BscReadRpcRequest[], signal: AbortSignal): Promise<unknown> {
    const response = await safeFetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(requests),
      timeoutMs: this.timeoutMilliseconds,
      maxBytes: 2_097_152,
      maxRequestBytes: 16_384,
      maxRedirects: 0,
      signal,
    })
    if (response.status !== 200) throw new Error("RPC returned a non-success status")
    return JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown
  }
}

export class BscChainReceiptObserver implements ChainReceiptObserver {
  private readonly rpcUrls: Readonly<Record<56 | 97, string>>
  private readonly transport: BscReadRpcTransport
  private readonly now: () => Date

  constructor(
    rpcUrls: Readonly<Record<56 | 97, string>>,
    transport: BscReadRpcTransport = new SafeBscReadRpcTransport(),
    now: () => Date = () => new Date(),
  ) {
    this.rpcUrls = {
      56: validatedRpcUrl(rpcUrls[56]),
      97: validatedRpcUrl(rpcUrls[97]),
    }
    this.transport = transport
    this.now = now
  }

  async observe(action: ChainActionRecord, signal: AbortSignal): Promise<ChainReceiptObservation | null> {
    if (signal.aborted) return null
    try {
      return await this.observeStrict(action, signal)
    } catch {
      return null
    }
  }

  private async observeStrict(
    action: ChainActionRecord,
    signal: AbortSignal,
  ): Promise<ChainReceiptObservation | null> {
    if (
      action.transactionHash === null ||
      action.nonce === null ||
      action.relayIntentId !== null ||
      action.transactionIntent === null ||
      action.signerAddress.toLowerCase() !== action.accountAddress.toLowerCase()
    ) return null
    const first = responseMap(await this.transport.batch(this.rpcUrls[action.chainId], [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getTransactionByHash", params: [action.transactionHash] },
      { jsonrpc: "2.0", id: 3, method: "eth_getTransactionReceipt", params: [action.transactionHash] },
    ], signal), [1, 2, 3])
    const observedChainId = decimalQuantity(quantity.parse(first.get(1)))
    if (observedChainId !== String(action.chainId)) return null
    const observedTransaction = transaction.parse(first.get(2))
    const observedReceipt = receipt.parse(first.get(3))
    if (
      observedTransaction.blockNumber === null ||
      observedTransaction.blockHash === null ||
      observedTransaction.to === null ||
      decimalQuantity(observedTransaction.type) !== "0" ||
      decimalQuantity(observedTransaction.chainId) !== String(action.chainId) ||
      observedTransaction.hash.toLowerCase() !== action.transactionHash.toLowerCase() ||
      observedReceipt.transactionHash.toLowerCase() !== action.transactionHash.toLowerCase() ||
      observedTransaction.from.toLowerCase() !== action.signerAddress.toLowerCase() ||
      decimalQuantity(observedTransaction.nonce) !== action.nonce ||
      observedTransaction.blockNumber !== observedReceipt.blockNumber ||
      observedTransaction.blockHash.toLowerCase() !== observedReceipt.blockHash.toLowerCase()
    ) return null
    const second = responseMap(await this.transport.batch(this.rpcUrls[action.chainId], [
      { jsonrpc: "2.0", id: 4, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 5, method: "eth_getBlockByNumber", params: [observedReceipt.blockNumber, false] },
    ], signal), [4, 5])
    const head = BigInt(quantity.parse(second.get(4)))
    const canonicalBlock = block.parse(second.get(5))
    const receiptBlock = BigInt(observedReceipt.blockNumber)
    if (
      canonicalBlock.number !== observedReceipt.blockNumber ||
      canonicalBlock.hash.toLowerCase() !== observedReceipt.blockHash.toLowerCase() ||
      head < receiptBlock
    ) return null
    const confirmations = head - receiptBlock + 1n
    if (confirmations > 10_000_000n) return null
    const observedIntent = {
      schemaVersion: "knot.evm-transaction-intent/1",
      taskId: action.taskId,
      actionSequence: action.actionSequence,
      semanticAction: action.semanticAction,
      signerAddress: observedTransaction.from,
      accountAddress: action.accountAddress,
      chainId: action.chainId,
      nonce: decimalQuantity(observedTransaction.nonce),
      destination: observedTransaction.to,
      valueUnits: decimalQuantity(observedTransaction.value),
      calldataHash: keccak256(observedTransaction.input as Hex),
      gasLimit: decimalQuantity(observedTransaction.gas),
      gasPriceUnits: decimalQuantity(observedTransaction.gasPrice),
    } as const
    const transactionIntentHash = hashEvmTransactionIntent(observedIntent)
    if (
      transactionIntentHash.toLowerCase() !== action.requestHash.toLowerCase() ||
      canonicalEvmTransactionIntentJson(observedIntent) !== canonicalEvmTransactionIntentJson(action.transactionIntent)
    ) return null
    const status = decimalQuantity(observedReceipt.status)
    if (status !== "0" && status !== "1") return null
    if (signal.aborted) return null
    return {
      chainId: action.chainId,
      transactionHash: observedTransaction.hash,
      transactionIntentHash,
      signerAddress: observedTransaction.from.toLowerCase(),
      nonce: decimalQuantity(observedTransaction.nonce),
      status: status === "1" ? "SUCCESS" : "REVERTED",
      blockNumber: decimalQuantity(observedReceipt.blockNumber),
      blockHash: observedReceipt.blockHash,
      confirmations: Number(confirmations),
      observedAtUtc: this.now().toISOString(),
    }
  }
}

function validatedRpcUrl(input: string): string {
  const url = validateSafeUrl(input)
  if (url.search !== "" || url.hash !== "") throw new RangeError("RPC URL cannot contain a query or fragment")
  return url.href
}

function responseMap(input: unknown, expectedIds: readonly number[]): ReadonlyMap<number, unknown> {
  const responses = z.array(rpcEnvelope).length(expectedIds.length).parse(input)
  const mapped = new Map<number, unknown>()
  for (const response of responses) {
    if (mapped.has(response.id)) throw new Error("RPC returned a duplicate response id")
    mapped.set(response.id, response.result)
  }
  if (expectedIds.some((id) => !mapped.has(id))) throw new Error("RPC omitted a requested response")
  return mapped
}

function decimalQuantity(input: string): string {
  return BigInt(input).toString()
}
