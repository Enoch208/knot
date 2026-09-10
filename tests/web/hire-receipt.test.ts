import assert from "node:assert/strict"
import { test } from "node:test"
import { readReceiptFrom, type ReceiptRpc } from "../../apps/web/src/hire-receipt.ts"

const hash = `0x${"1".repeat(64)}` as const
const blockHash = `0x${"2".repeat(64)}` as const
const reader = (): ReceiptRpc => ({
  getChainId: async () => 97,
  getBlockNumber: async () => 43n,
  getTransactionReceipt: async () => ({ transactionHash: hash, status: "success", blockNumber: 42n, blockHash, logs: [] }),
  getBlock: async () => ({ hash: blockHash }),
  getTransaction: async () => ({ hash, from: `0x${"3".repeat(40)}`, to: `0x${"4".repeat(40)}`, input: "0x", value: 0n, chainId: 97, blockHash }),
})
test("HIRE-RECEIPT-01 accepts only a canonical testnet receipt with two confirmations", async () => {
  assert.equal((await readReceiptFrom(reader(), hash))?.status, "success")
  assert.equal(await readReceiptFrom({ ...reader(), getBlockNumber: async () => 42n }, hash), null)
  await assert.rejects(readReceiptFrom({ ...reader(), getChainId: async () => 56 }, hash), /not on BSC testnet/)
  await assert.rejects(readReceiptFrom({ ...reader(), getBlock: async () => ({ hash: `0x${"5".repeat(64)}` }) }, hash), /not.*canonical|no longer canonical/)
})
test("HIRE-RECEIPT-02 rejects mismatched transaction identity and chain", async () => {
  const rpc = reader()
  const tx = await rpc.getTransaction({ hash })
  for (const mutation of [{ hash: `0x${"6".repeat(64)}` }, { chainId: 56 }, { blockHash: null }]) {
    await assert.rejects(readReceiptFrom({ ...rpc, getTransaction: async () => ({ ...tx, ...mutation }) }, hash), /disagree/)
  }
})
