// Display-only projection of evidence/claims.json, bundled for standalone web deployments.
import ledgerSnapshot from "./claim-ledger.snapshot.json"

export type ClaimStatus = "SUPPORTED" | "PARTIAL" | "UNMEASURED" | "NOT_CLAIMED"

export interface ClaimRow {
  id: string
  status: ClaimStatus
  evidenceClasses: readonly string[]
  observedAtUtc: string | null
}

export interface ClaimLedger {
  total: number
  statusCounts: ReadonlyArray<{ status: ClaimStatus; count: number }>
  evidenceCounts: ReadonlyArray<{ evidenceClass: string; count: number }>
  rows: readonly ClaimRow[]
}

const STATUS_ORDER: readonly ClaimStatus[] = ["SUPPORTED", "PARTIAL", "UNMEASURED", "NOT_CLAIMED"]

interface RawClaim {
  id?: unknown
  status?: unknown
  evidenceClasses?: unknown
  observedAtUtc?: unknown
}

const isStatus = (value: unknown): value is ClaimStatus =>
  typeof value === "string" && (STATUS_ORDER as readonly string[]).includes(value)

const toRow = (entry: RawClaim): ClaimRow | null => {
  if (typeof entry.id !== "string" || !isStatus(entry.status)) return null
  const classes = Array.isArray(entry.evidenceClasses)
    ? entry.evidenceClasses.filter((value): value is string => typeof value === "string")
    : []
  return {
    id: entry.id,
    status: entry.status,
    evidenceClasses: classes,
    observedAtUtc: typeof entry.observedAtUtc === "string" ? entry.observedAtUtc : null,
  }
}

const tally = <T extends string>(values: readonly T[]): Map<T, number> => {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

export async function readClaimLedger(): Promise<ClaimLedger> {
  const parsed: unknown = ledgerSnapshot
  const entries: RawClaim[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { claims?: unknown }).claims)
      ? ((parsed as { claims: RawClaim[] }).claims)
      : []

  const rows = entries.map(toRow).filter((row): row is ClaimRow => row !== null)
  const statusTally = tally(rows.map((row) => row.status))
  const evidenceTally = tally(rows.flatMap((row) => [...row.evidenceClasses]))

  return {
    total: rows.length,
    statusCounts: STATUS_ORDER.map((status) => ({ status, count: statusTally.get(status) ?? 0 })),
    evidenceCounts: [...evidenceTally.entries()]
      .map(([evidenceClass, count]) => ({ evidenceClass, count }))
      .sort((left, right) => right.count - left.count),
    rows,
  }
}
