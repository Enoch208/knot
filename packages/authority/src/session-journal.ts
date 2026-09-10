import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export interface SessionJournalState {
  keyHash: string
  phase?: "prepared" | "grant-submitted" | "active" | "grant-reverted" | "revoke-submitted" | "revoked"
}

export async function withSessionJournalLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  const lock = await open(`${path}.lock`, "wx", 0o600)
  try { return await run() } finally { await lock.close(); await unlink(`${path}.lock`) }
}

export async function readSessionJournal<T extends SessionJournalState>(path: string): Promise<T | null> {
  let raw: string
  try { raw = await readFile(path, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const state = JSON.parse(raw) as T
  if (!/^0x[0-9a-fA-F]{64}$/.test(state.keyHash)) throw new Error("Invalid session recovery journal.")
  return state
}

export async function saveSessionJournal<T extends SessionJournalState>(path: string, state: T): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), "r")
  try { await directory.sync() } finally { await directory.close() }
}

export async function beginSessionJournal<T extends SessionJournalState>(path: string, state: T): Promise<void> {
  const existing = await readSessionJournal(path)
  if (existing && existing.phase !== "revoked" && existing.phase !== "grant-reverted") {
    throw new Error("An active or uncertain session exists. Reconcile and revoke it before granting another.")
  }
  if (existing) {
    const archive = await open(`${path}.${existing.keyHash}.${randomUUID()}.archive`, "wx", 0o600)
    try { await archive.writeFile(await readFile(path)); await archive.sync() } finally { await archive.close() }
  }
  await saveSessionJournal(path, state)
}
