import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  canonicalEvmTransactionIntentJson,
  hashEvmTransactionIntent,
  parseEvmTransactionIntent,
} from "../../packages/chain/src/transaction-intent.ts"

const intent = () => ({
  schemaVersion: "knot.evm-transaction-intent/1",
  taskId: "task-range-7391321",
  actionSequence: 3,
  semanticAction: "decreaseLiquidity",
  signerAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  accountAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  chainId: 97,
  nonce: "42",
  destination: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  valueUnits: "0",
  calldataHash: `0x${"c".repeat(64)}`,
  gasLimit: "350000",
  gasPriceUnits: "3000000000",
})

const canonical = "{\"schemaVersion\":\"knot.evm-transaction-intent/1\",\"taskId\":\"task-range-7391321\",\"actionSequence\":3,\"semanticAction\":\"decreaseLiquidity\",\"signerAddress\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"accountAddress\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"chainId\":97,\"nonce\":\"42\",\"destination\":\"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"valueUnits\":\"0\",\"calldataHash\":\"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"gasLimit\":\"350000\",\"gasPriceUnits\":\"3000000000\"}"

describe("canonical direct EOA transaction intent", () => {
  it("normalizes addresses and produces a fixed golden commitment", () => {
    const parsed = parseEvmTransactionIntent(intent())
    assert.equal(parsed.signerAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    assert.equal(parsed.accountAddress, parsed.signerAddress)
    assert.equal(parsed.destination, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    assert.equal(canonicalEvmTransactionIntentJson(intent()), canonical)
    assert.equal(hashEvmTransactionIntent(intent()), "0x84353132eabb607e3e6f51bd4de151596e58f1d9f9ceaa496c8662842a537a96")
    assert.equal(hashEvmTransactionIntent({ ...intent(), signerAddress: parsed.signerAddress }), hashEvmTransactionIntent(intent()))
  })

  it("changes or rejects the commitment when every bound field is tampered", () => {
    const original = intent()
    const originalHash = hashEvmTransactionIntent(original)
    const validChanges: ReadonlyArray<readonly [keyof typeof original, unknown]> = [
      ["taskId", "task-range-other"],
      ["actionSequence", 4],
      ["semanticAction", "collect"],
      ["chainId", 56],
      ["nonce", "43"],
      ["destination", "0xdddddddddddddddddddddddddddddddddddddddd"],
      ["valueUnits", "1"],
      ["calldataHash", `0x${"d".repeat(64)}`],
      ["gasLimit", "350001"],
      ["gasPriceUnits", "3000000001"],
    ]
    for (const [field, value] of validChanges) {
      assert.notEqual(hashEvmTransactionIntent({ ...original, [field]: value }), originalHash, field)
    }
    for (const [field, value] of [
      ["schemaVersion", "knot.evm-transaction-intent/2"],
      ["signerAddress", "0xdddddddddddddddddddddddddddddddddddddddd"],
      ["accountAddress", "0xdddddddddddddddddddddddddddddddddddddddd"],
    ] as const) {
      assert.throws(() => hashEvmTransactionIntent({ ...original, [field]: value }), field)
    }
  })

  it("rejects unknown, missing, malformed, and noncanonical fields", () => {
    const original = intent()
    assert.throws(() => parseEvmTransactionIntent({ ...original, unexpected: true }))
    for (const field of Object.keys(original)) {
      const missing = { ...original } as Record<string, unknown>
      delete missing[field]
      assert.throws(() => parseEvmTransactionIntent(missing), field)
    }
    for (const field of ["nonce", "valueUnits", "gasLimit", "gasPriceUnits"] as const) {
      for (const value of ["", "-1", "+1", "01", "1.0", "1e3", " 1"]) {
        assert.throws(() => parseEvmTransactionIntent({ ...original, [field]: value }), `${field}:${value}`)
      }
    }
    assert.throws(() => parseEvmTransactionIntent({ ...original, actionSequence: -1 }))
    assert.throws(() => parseEvmTransactionIntent({ ...original, actionSequence: Number.MAX_SAFE_INTEGER + 1 }))
    assert.throws(() => parseEvmTransactionIntent({ ...original, chainId: 1 }))
    assert.throws(() => parseEvmTransactionIntent({ ...original, destination: "0x1234" }))
    assert.throws(() => parseEvmTransactionIntent({ ...original, calldataHash: `0x${"C".repeat(64)}` }))
  })
})
