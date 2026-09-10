import { assertReceipt, prepareFunding } from "./hire-calls.ts"
import { readJournal, saveJournal, type JournalStorage } from "./hire-journal.ts"
import type { ConfirmedReceipt, HireJournal } from "./hire-types.ts"
import { requireWalletIdentity, submitCall, type Eip1193Provider } from "./wallet.ts"

export interface HireRunner {
  storage: JournalStorage
  provider: Eip1193Provider
  receipt(hash: string): Promise<ConfirmedReceipt | null>
  now(): number
  changed(journal: HireJournal): void
}

export async function recoverHireHash(id: string, hash: string, runner: HireRunner): Promise<void> {
  const journal = readJournal(runner.storage, id)
  if (!journal || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("A saved attempt and valid transaction hash are required.")
  const index = journal.progress.findIndex(p => p.transactionHash === null && ["signing", "unresolved"].includes(p.state))
  if (index < 0) throw new Error("No unknown submission is awaiting a hash.")
  const receipt = await runner.receipt(hash)
  if (!receipt) throw new Error("That transaction is not yet confirmed; retry recovery later.")
  assertReceipt(receipt, hash, journal.prepared.calls[index]!, journal.prepared.envelope.buyer)
  journal.progress[index] = { state: "submitted", transactionHash: hash }
  saveJournal(runner.storage, journal)
  runner.changed(structuredClone(journal))
  await runHirePhase(id, runner, false)
}

export async function runHirePhase(id: string, runner: HireRunner, send: boolean): Promise<void> {
  const journal = readJournal(runner.storage, id)
  if (!journal) throw new Error("No saved hire exists.")
  const persist = (): void => { saveJournal(runner.storage, journal); runner.changed(structuredClone(journal)) }
  if (journal.prepared.stage === "FUND") {
    const creation = await runner.receipt(journal.creationHash!)
    if (!creation || JSON.stringify(prepareFunding(journal.creation, creation)) !== JSON.stringify(journal.prepared)) {
      throw new Error("The creation must still be confirmed before funding or recovery.")
    }
  }
  for (let index = 0; index < journal.progress.length; index += 1) {
    const entry = journal.progress[index]!
    const call = journal.prepared.calls[index]!
    if (entry.transactionHash) {
      const receipt = await runner.receipt(entry.transactionHash)
      if (!receipt) throw new Error("Receipt pending. Check saved progress again; do not start another hire.")
      assertReceipt(receipt, entry.transactionHash, call, journal.prepared.envelope.buyer)
      entry.state = receipt.status === "success" ? "confirmed" : "reverted"
      persist()
      if (entry.state === "reverted") throw new Error("A saved call reverted. Earlier calls and gas charges remain; manual reconciliation is required.")
      if (journal.prepared.stage === "CREATE") {
        journal.prepared = prepareFunding(journal.creation, receipt)
        journal.creationHash = receipt.transactionHash
        journal.progress = journal.prepared.calls.map(() => ({ state: "waiting", transactionHash: null }))
        persist()
        return
      }
      continue
    }
    if (["signing", "unresolved", "confirmed", "reverted"].includes(entry.state)) throw new Error("A saved submission has no verified hash. Reconcile it in your wallet; it will not be resent.")
    if (!send) return
    const e = journal.prepared.envelope
    if (runner.now() >= e.quoteExpiresAtUnix || runner.now() + e.disputeWindowSeconds >= e.expiredAtUnix) throw new Error("The quote or safe funding window expired. No additional call was sent.")
    await requireWalletIdentity(runner.provider, e.buyer)
    entry.state = "signing"
    persist()
    const result = await submitCall(runner.provider, e.buyer, call)
    if (result.status === "submitted") {
      entry.transactionHash = result.transactionHash
      entry.state = "submitted"
      persist()
      return
    }
    entry.state = result.status === "rejected" ? "not attempted" : "unresolved"
    persist()
    throw new Error(result.status === "rejected" ? "You declined this call. Earlier transactions, if any, remain recorded." : "Submission outcome unknown. Check your wallet; this call will not be resent.")
  }
}
