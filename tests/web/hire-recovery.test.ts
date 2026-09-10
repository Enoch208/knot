import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeFunctionData } from "viem"
import { assertReceipt, hireAbi, prepareFunding, validatePrepared } from "../../apps/web/src/hire-calls.ts"
import { beginJournal, readJournal, saveJournal } from "../../apps/web/src/hire-journal.ts"
import { recoverHireHash, runHirePhase, type HireRunner } from "../../apps/web/src/hire-runner.ts"
import { submitCall } from "../../apps/web/src/wallet.ts"
import { buyer, creationReceipt, hash, MemoryStorage, now, prepared } from "./hire-fixtures.ts"

function fixture() {
  const storage = new MemoryStorage()
  const p = prepared()
  beginJournal(storage, p)
  let sends = 0
  let chain = "0x61"
  let account = buyer
  const runner: HireRunner = {
    storage, now: () => now, changed: () => {}, receipt: async () => creationReceipt(),
    provider: { request: async ({ method, params }) => {
      if (method === "eth_chainId") return chain
      if (method === "eth_accounts") return [account]
      if (method === "eth_sendTransaction") {
        assert.equal((params?.[0] as { chainId: string }).chainId, "0x61")
        sends += 1
        return hash
      }
      throw new Error(`Unexpected wallet method ${method}`)
    } },
  }
  return { runner, p, storage, sends: () => sends, switchChain: () => { chain = "0x38" }, switchAccount: () => { account = `0x${"2".repeat(40)}` } }
}

test("HIRE-ID-02 funding calls use the ID emitted by creation, not a prediction", () => {
  const fund = prepareFunding(prepared(), creationReceipt())
  assert.equal(fund.envelope.jobId, "1234")
  for (const index of [0, 1, 3]) {
    const decoded = decodeFunctionData({ abi: hireAbi, data: fund.calls[index]!.data as `0x${string}` })
    assert.equal(decoded.args[0], 1234n)
  }
  assert.throws(() => prepareFunding(prepared(), { ...creationReceipt(), logs: [] }), /unique job/)
  assert.throws(() => prepareFunding(prepared(), { ...creationReceipt(), logs: [...creationReceipt().logs, ...creationReceipt().logs] }), /unique job/)
})
test("HIRE-ID-03 refuses forged buyer, target, calldata, and chain in receipts", () => {
  const p = prepared()
  for (const mutation of [{ from: `0x${"2".repeat(40)}` }, { to: `0x${"3".repeat(40)}` }, { input: "0x" }, { chainId: 56 }]) {
    const receipt = creationReceipt()
    receipt.transaction = { ...receipt.transaction, ...mutation }
    assert.throws(() => assertReceipt(receipt, hash, p.calls[0]!, buyer), /saved testnet intent/)
  }
})
test("HIRE-NET-01 refuses mainnet and a mismatched buyer before sending", async () => {
  for (const change of ["switchChain", "switchAccount"] as const) {
    const f = fixture()
    f[change]()
    await assert.rejects(runHirePhase(f.p.verifiedQuoteId, f.runner, true), /testnet|buyer/)
    assert.equal(f.sends(), 0)
    assert.equal(readJournal(f.storage, f.p.verifiedQuoteId)?.progress[0]?.state, "waiting")
  }
})
test("HIRE-NET-02 each individual submission rechecks the selected network", async () => {
  const f = fixture()
  assert.equal((await submitCall(f.runner.provider, buyer, f.p.calls[0]!)).status, "submitted")
  f.switchChain()
  assert.equal((await submitCall(f.runner.provider, buyer, f.p.calls[0]!)).status, "unresolved")
  assert.equal(f.sends(), 1)
})
test("HIRE-RECOVERY-01 reload recovers creation then stops for funding review without resending", async () => {
  const f = fixture()
  const request = f.runner.provider.request
  f.runner.provider.request = async args => {
    if (args.method === "eth_sendTransaction") assert.equal(readJournal(f.storage, f.p.verifiedQuoteId)?.progress[0]?.state, "signing")
    return request(args)
  }
  await runHirePhase(f.p.verifiedQuoteId, f.runner, true)
  assert.equal(readJournal(f.storage, f.p.verifiedQuoteId)?.progress[0]?.transactionHash, hash)
  await runHirePhase(f.p.verifiedQuoteId, { ...f.runner, provider: { request: async () => { throw new Error("recovery must not request the wallet") } } }, false)
  assert.equal(readJournal(f.storage, f.p.verifiedQuoteId)?.prepared.envelope.jobId, "1234")
  assert.equal(f.sends(), 1)
  assert.equal(beginJournal(f.storage, f.p).prepared.stage, "FUND")
})
test("HIRE-RECOVERY-02 an unknown submission is never automatically retried", async () => {
  const f = fixture()
  const journal = readJournal(f.storage, f.p.verifiedQuoteId)!
  journal.progress[0]!.state = "signing"
  saveJournal(f.storage, journal)
  await assert.rejects(runHirePhase(f.p.verifiedQuoteId, f.runner, true), /no verified hash/)
  assert.equal(f.sends(), 0)
})
test("HIRE-RECOVERY-03 storage failure and expiry prevent wallet requests", async () => {
  const f = fixture()
  f.runner.storage = { getItem: key => f.storage.getItem(key), setItem: () => { throw new Error("storage full") } }
  await assert.rejects(runHirePhase(f.p.verifiedQuoteId, f.runner, true), /storage full/)
  assert.equal(f.sends(), 0)
  await assert.rejects(runHirePhase(f.p.verifiedQuoteId, { ...f.runner, now: () => now + 601 }, true), /expired/)
})
test("HIRE-RECOVERY-04 missing/reverted receipts cannot advance to funding", async () => {
  const f = fixture()
  await runHirePhase(f.p.verifiedQuoteId, f.runner, true)
  await assert.rejects(runHirePhase(f.p.verifiedQuoteId, { ...f.runner, receipt: async () => null }, false), /pending/)
  await assert.rejects(runHirePhase(f.p.verifiedQuoteId, { ...f.runner, receipt: async () => ({ ...creationReceipt(), status: "reverted" }) }, false), /reverted/)
  assert.equal(f.sends(), 1)
})
test("HIRE-BOUNDARY-01 rejects tampered prepared calls and saved progress", () => {
  const p = prepared()
  assert.throws(() => validatePrepared({ ...p, calls: [{ ...p.calls[0], data: "0x" }] }, p.verifiedQuoteId), /calldata/)
  const storage = new MemoryStorage()
  storage.setItem(`knot.hire/2:${p.verifiedQuoteId}`, "not json")
  assert.throws(() => beginJournal(storage, p))
})

test("HIRE-RECOVERY-05 a recovered hash must match the saved intent and never resends", async () => {
  const f = fixture()
  const journal = readJournal(f.storage, f.p.verifiedQuoteId)!
  journal.progress[0]!.state = "unresolved"
  saveJournal(f.storage, journal)
  await assert.rejects(recoverHireHash(f.p.verifiedQuoteId, `0x${"9".repeat(64)}`, f.runner), /saved testnet intent/)
  await recoverHireHash(f.p.verifiedQuoteId, hash, f.runner)
  assert.equal(f.sends(), 0)
  assert.equal(readJournal(f.storage, f.p.verifiedQuoteId)?.prepared.envelope.jobId, "1234")
})

test("HIRE-RECOVERY-06 each funding call is persisted and receipts reconcile without another send", async () => {
  const f = fixture()
  await runHirePhase(f.p.verifiedQuoteId, f.runner, true)
  await runHirePhase(f.p.verifiedQuoteId, f.runner, false)
  const fund = readJournal(f.storage, f.p.verifiedQuoteId)!.prepared
  const receipts = new Map([[hash, creationReceipt()]])
  let index = 0
  f.runner.receipt = async txHash => receipts.get(txHash) ?? null
  const request = f.runner.provider.request
  f.runner.provider.request = async args => {
    if (args.method !== "eth_sendTransaction") return request(args)
    const txHash = `0x${String(index + 2).repeat(64)}`
    const call = fund.calls[index++]!
    receipts.set(txHash, { ...creationReceipt(), transactionHash: txHash, logs: [], transaction: { from: buyer, to: call.to, input: call.data, value: call.value, chainId: 97 } })
    return txHash
  }
  for (let call = 0; call < 4; call++) {
    await runHirePhase(f.p.verifiedQuoteId, f.runner, true)
    await runHirePhase(f.p.verifiedQuoteId, f.runner, false)
  }
  assert.equal(index, 4)
  assert.ok(readJournal(f.storage, f.p.verifiedQuoteId)!.progress.every(p => p.state === "confirmed"))
  await runHirePhase(f.p.verifiedQuoteId, f.runner, true)
  assert.equal(index, 4)
})
