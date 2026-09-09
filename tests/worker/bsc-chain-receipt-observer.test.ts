import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { keccak256 } from "viem"
import {
  BscChainReceiptObserver,
  type BscReadRpcRequest,
  type BscReadRpcTransport,
} from "../../apps/worker/src/bsc-chain-receipt-observer.ts"
import { hashEvmTransactionIntent } from "../../packages/chain/src/transaction-intent.ts"
import type { ChainActionRecord } from "../../packages/db/src/chain-action-repository.ts"

const transactionHash = `0x${"1".repeat(64)}`
const blockHash = `0x${"2".repeat(64)}`
const changedBlockHash = `0x${"3".repeat(64)}`
const signerAddress = `0x${"4".repeat(40)}` as const
const destination = `0x${"5".repeat(40)}` as const
const input = "0x1234"
const now = () => new Date("2026-09-09T18:00:00Z")
const rpcUrls = { 56: "https://bsc.example/rpc", 97: "https://testnet.example/rpc" } as const

const intent = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: "knot.evm-transaction-intent/1" as const,
  taskId: "task-1",
  actionSequence: 0,
  semanticAction: "fund",
  signerAddress,
  accountAddress: signerAddress,
  chainId: 97 as const,
  nonce: "17",
  destination,
  valueUnits: "0",
  calldataHash: keccak256(input),
  gasLimit: "21000",
  gasPriceUnits: "3000000000",
  ...overrides,
})

const action = (overrides: Partial<ChainActionRecord> = {}): ChainActionRecord => {
  const transactionIntent = intent()
  return {
    id: "action-1",
    jobId: "job-1",
    sessionId: "session-1",
    taskId: "task-1",
    actionSequence: 0,
    semanticAction: "fund",
    signerAddress,
    accountAddress: signerAddress,
    chainId: 97,
    nonce: "17",
    relayIntentId: null,
    requestHash: hashEvmTransactionIntent(transactionIntent),
    transactionIntent,
    transactionHash,
    state: "SUBMITTED",
    reconciliation: {},
    version: 0,
    ...overrides,
  }
}

const rpcTransaction = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  hash: transactionHash,
  from: signerAddress,
  to: destination,
  nonce: "0x11",
  input,
  value: "0x0",
  gas: "0x5208",
  gasPrice: "0xb2d05e00",
  type: "0x0",
  chainId: "0x61",
  blockNumber: "0x64",
  blockHash,
  ...overrides,
})

const rpcReceipt = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  transactionHash,
  status: "0x1",
  blockNumber: "0x64",
  blockHash,
  ...overrides,
})

const firstBatch = (
  transactionOverrides: Readonly<Record<string, unknown>> = {},
  receiptOverrides: Readonly<Record<string, unknown>> = {},
  chainId: unknown = "0x61",
) => [
  { jsonrpc: "2.0", id: 1, result: chainId },
  { jsonrpc: "2.0", id: 2, result: rpcTransaction(transactionOverrides) },
  { jsonrpc: "2.0", id: 3, result: rpcReceipt(receiptOverrides) },
]

const secondBatch = (blockOverrides: Readonly<Record<string, unknown>> = {}, head: unknown = "0x66") => [
  { jsonrpc: "2.0", id: 4, result: head },
  { jsonrpc: "2.0", id: 5, result: { number: "0x64", hash: blockHash, ...blockOverrides } },
]

class FakeRpc implements BscReadRpcTransport {
  readonly calls: Array<{ url: string; methods: readonly string[] }> = []
  private readonly responses: unknown[]

  constructor(responses: unknown[]) {
    this.responses = [...responses]
  }

  async batch(url: string, requests: readonly BscReadRpcRequest[], signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("aborted")
    this.calls.push({ url, methods: requests.map((request) => request.method) })
    if (this.responses.length === 0) throw new Error("unexpected RPC call")
    return this.responses.shift()
  }
}

describe("read-only BSC receipt observation", () => {
  it("derives a successful intent-bound observation from canonical transaction and receipt data", async () => {
    const rpc = new FakeRpc([firstBatch(), secondBatch()])
    const observed = await new BscChainReceiptObserver(rpcUrls, rpc, now).observe(action(), new AbortController().signal)
    assert.deepEqual(observed, {
      chainId: 97,
      transactionHash,
      transactionIntentHash: action().requestHash,
      signerAddress,
      nonce: "17",
      status: "SUCCESS",
      blockNumber: "100",
      blockHash,
      confirmations: 3,
      observedAtUtc: "2026-09-09T18:00:00.000Z",
    })
    assert.deepEqual(rpc.calls, [
      { url: "https://testnet.example/rpc", methods: ["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt"] },
      { url: "https://testnet.example/rpc", methods: ["eth_blockNumber", "eth_getBlockByNumber"] },
    ])
  })

  it("reports a canonical reverted receipt without converting transport failure into a revert", async () => {
    const reverted = new FakeRpc([firstBatch({}, { status: "0x0" }), secondBatch()])
    assert.equal(
      (await new BscChainReceiptObserver(rpcUrls, reverted, now).observe(action(), new AbortController().signal))?.status,
      "REVERTED",
    )
    const failed: BscReadRpcTransport = {
      batch: async () => { throw new Error("untrusted failure") },
    }
    assert.equal(await new BscChainReceiptObserver(rpcUrls, failed, now).observe(action(), new AbortController().signal), null)
  })

  it("refuses hashless, relay, account-abstraction, and aborted actions before RPC", async () => {
    for (const [changed, aborted] of [
      [{ transactionHash: null }, false],
      [{ relayIntentId: "relay" }, false],
      [{ accountAddress: `0x${"6".repeat(40)}` }, false],
      [{}, true],
    ] as const) {
      const rpc = new FakeRpc([])
      const controller = new AbortController()
      if (aborted) controller.abort()
      assert.equal(await new BscChainReceiptObserver(rpcUrls, rpc, now).observe(action(changed), controller.signal), null)
      assert.equal(rpc.calls.length, 0)
    }
  })

  it("fails closed on wrong chain, transaction identity, nonce, and reconstructed intent", async () => {
    for (const batches of [
      [firstBatch({}, {}, "0x38")],
      [firstBatch({ hash: `0x${"7".repeat(64)}` })],
      [firstBatch({ from: `0x${"8".repeat(40)}` })],
      [firstBatch({ nonce: "0x12" })],
      [firstBatch({ to: `0x${"9".repeat(40)}` }), secondBatch()],
      [firstBatch({ input: "0x5678" }), secondBatch()],
      [firstBatch({ value: "0x1" }), secondBatch()],
      [firstBatch({ gas: "0x5209" }), secondBatch()],
      [firstBatch({ gasPrice: "0xb2d05e01" }), secondBatch()],
    ]) {
      assert.equal(
        await new BscChainReceiptObserver(rpcUrls, new FakeRpc(batches), now).observe(action(), new AbortController().signal),
        null,
      )
    }
  })

  it("fails closed on pending, malformed, non-legacy, and ambiguous RPC responses", async () => {
    for (const batches of [
      [[
        { jsonrpc: "2.0", id: 1, result: "0x61" },
        { jsonrpc: "2.0", id: 2, result: null },
        { jsonrpc: "2.0", id: 3, result: null },
      ]],
      [firstBatch({ type: "0x2" })],
      [firstBatch({}, { status: "0x2" }), secondBatch()],
      [[...firstBatch(), firstBatch()[0]]],
      [[
        { jsonrpc: "2.0", id: 1, result: "0x61" },
        { jsonrpc: "2.0", id: 2, result: rpcTransaction() },
      ]],
    ]) {
      assert.equal(
        await new BscChainReceiptObserver(rpcUrls, new FakeRpc(batches), now).observe(action(), new AbortController().signal),
        null,
      )
    }
  })

  it("fails closed on receipt disagreement, a reorged block, and an impossible head", async () => {
    for (const batches of [
      [firstBatch({}, { blockHash: changedBlockHash })],
      [firstBatch(), secondBatch({ hash: changedBlockHash })],
      [firstBatch(), secondBatch({}, "0x63")],
    ]) {
      assert.equal(
        await new BscChainReceiptObserver(rpcUrls, new FakeRpc(batches), now).observe(action(), new AbortController().signal),
        null,
      )
    }
  })

  it("rejects unsafe RPC configuration and exposes no broadcast method", () => {
    for (const changed of [
      { 56: "http://bsc.example/rpc", 97: rpcUrls[97] },
      { 56: "https://127.0.0.1/rpc", 97: rpcUrls[97] },
      { 56: "https://user:secret@bsc.example/rpc", 97: rpcUrls[97] },
      { 56: "https://bsc.example/rpc?key=secret", 97: rpcUrls[97] },
    ] as const) {
      assert.throws(() => new BscChainReceiptObserver(changed, new FakeRpc([]), now))
    }
    assert.doesNotMatch(
      readFileSync("apps/worker/src/bsc-chain-receipt-observer.ts", "utf8"),
      /eth_sendRawTransaction|eth_sendTransaction|writeContract|sendTransaction/,
    )
  })
})
