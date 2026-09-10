import { validatePrepared } from "./hire-calls.ts"
import type { HireJournal, PreparedHire } from "./hire-types.ts"

export interface JournalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const keyFor = (id: string): string => `knot.hire/2:${id}`
const indexKey = "knot.hire/2:index"
const states = new Set(["waiting", "signing", "submitted", "confirmed", "reverted", "unresolved", "not attempted"])

export function readJournal(storage: JournalStorage, id: string): HireJournal | null {
  const raw = storage.getItem(keyFor(id))
  if (raw === null) return null
  const journal = JSON.parse(raw) as HireJournal
  if (journal.version !== 1 || journal.creation.stage !== "CREATE") throw new Error("Saved hire cannot be safely recovered.")
  validatePrepared(journal.creation, id)
  validatePrepared(journal.prepared, id)
  const { jobId: _a, callCount: _b, ...initial } = journal.creation.envelope
  const { jobId: _c, callCount: _d, ...current } = journal.prepared.envelope
  if (JSON.stringify(initial) !== JSON.stringify(current) || !Array.isArray(journal.progress) || journal.progress.length !== journal.prepared.calls.length ||
      journal.progress.some(p => !states.has(p.state) || (p.transactionHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(p.transactionHash)) ||
        (["submitted", "confirmed"].includes(p.state) && p.transactionHash === null)) ||
      (journal.prepared.stage === "FUND" && !/^0x[0-9a-fA-F]{64}$/.test(journal.creationHash ?? ""))) {
    throw new Error("Saved hire is inconsistent; reconcile it before retrying.")
  }
  return journal
}

export function saveJournal(storage: JournalStorage, journal: HireJournal): void {
  const encoded = JSON.stringify(journal)
  storage.setItem(keyFor(journal.creation.verifiedQuoteId), encoded)
  if (storage.getItem(keyFor(journal.creation.verifiedQuoteId)) !== encoded) throw new Error("Hire progress could not be saved; no further call may be sent.")
  readJournal(storage, journal.creation.verifiedQuoteId)
  const ids = readSavedHireIds(storage)
  if (!ids.includes(journal.creation.verifiedQuoteId)) {
    const encodedIds = JSON.stringify([...ids, journal.creation.verifiedQuoteId])
    storage.setItem(indexKey, encodedIds)
    if (storage.getItem(indexKey) !== encodedIds) throw new Error("Hire recovery index could not be saved.")
  }
}

export function readSavedHireIds(storage: JournalStorage): string[] {
  const ids: unknown = JSON.parse(storage.getItem(indexKey) ?? "[]")
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("Saved hire index is invalid.")
  return ids as string[]
}

export function beginJournal(storage: JournalStorage, prepared: PreparedHire): HireJournal {
  const existing = readJournal(storage, prepared.verifiedQuoteId)
  if (existing) return existing
  validatePrepared(prepared, prepared.verifiedQuoteId)
  if (prepared.stage !== "CREATE") throw new Error("A hire must start with creation.")
  const journal: HireJournal = { version: 1, creation: prepared, prepared, creationHash: null, progress: [{ state: "waiting", transactionHash: null }] }
  saveJournal(storage, journal)
  return journal
}
