#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "evidence", "claims.json")
const TARGET = join(ROOT, "apps", "web", "src", "claim-ledger.snapshot.json")

const STATUSES = new Set(["SUPPORTED", "PARTIAL", "UNMEASURED", "NOT_CLAIMED"])

interface SnapshotRow {
  id: string
  status: string
  evidenceClasses: string[]
  observedAtUtc: string | null
}

export interface LedgerSnapshot {
  updatedAtUtc: string
  claims: SnapshotRow[]
}

const asRows = (parsed: unknown): Record<string, unknown>[] => {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
  const claims = (parsed as { claims?: unknown }).claims
  return Array.isArray(claims) ? (claims as Record<string, unknown>[]) : []
}

export function projectLedger(parsed: unknown, updatedAtUtc: string): LedgerSnapshot {
  const claims: SnapshotRow[] = []
  for (const entry of asRows(parsed)) {
    const id = entry.id
    const status = entry.status
    if (typeof id !== "string" || typeof status !== "string" || !STATUSES.has(status)) continue
    const classes = Array.isArray(entry.evidenceClasses)
      ? entry.evidenceClasses.filter((value): value is string => typeof value === "string")
      : []
    claims.push({
      id,
      status,
      evidenceClasses: classes,
      observedAtUtc: typeof entry.observedAtUtc === "string" ? entry.observedAtUtc : null,
    })
  }
  return { updatedAtUtc, claims }
}

export async function readSourceLedger(): Promise<unknown> {
  return JSON.parse(await readFile(SOURCE, "utf8")) as unknown
}

export async function readSnapshot(): Promise<LedgerSnapshot> {
  return JSON.parse(await readFile(TARGET, "utf8")) as LedgerSnapshot
}

export const snapshotPath = TARGET

async function main(): Promise<void> {
  const existing = await readSnapshot().catch(() => null)
  const projected = projectLedger(await readSourceLedger(), new Date().toISOString())
  const unchanged =
    existing !== null && JSON.stringify(existing.claims) === JSON.stringify(projected.claims)
  const output: LedgerSnapshot = unchanged
    ? { updatedAtUtc: existing.updatedAtUtc, claims: projected.claims }
    : projected

  await writeFile(TARGET, `${JSON.stringify(output, null, 2)}\n`)
  process.stderr.write(
    `[claim-ledger] ${output.claims.length} claim(s) projected; snapshot ${unchanged ? "unchanged" : "updated"}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
