import snapshot from "./comparison.snapshot.json"

export type ComparisonOutcome =
  | "NO_COMPATIBLE_CANDIDATE"
  | "SINGLE_CANDIDATE"
  | "NOT_COMPARABLE"
  | "TIE"
  | "DECIDED"

export interface ComparisonRow {
  key: string
  displayName: string
  operatorRelationship: string
  availability: string
  priceBaseUnits: string | null
  completedJobs: number | null
  refundedJobs: number | null
  evidenceClass: string | null
  eligible: boolean
  exclusionReason: string | null
}

export interface CategoryComparison {
  key: string
  label: string
  comparison: {
    outcome: ComparisonOutcome
    decisiveDimension: string | null
    recommendedKey: string | null
    operatorIndependence: string
    rows: readonly ComparisonRow[]
    limitations: readonly string[]
  }
}

export interface ComparisonSnapshot {
  observationsThroughUtc: string
  categories: readonly CategoryComparison[]
}

export const comparisonSnapshot: ComparisonSnapshot = snapshot as ComparisonSnapshot

export const formatUnits = (baseUnits: string | null): string => {
  if (baseUnits === null) return "unavailable"
  const padded = baseUnits.padStart(19, "0")
  const whole = padded.slice(0, -18)
  const fraction = padded.slice(-18).replace(/0+$/, "")
  return fraction.length === 0 ? `${whole} U` : `${whole}.${fraction} U`
}

export const deliveryRecord = (row: ComparisonRow): string => {
  if (row.completedJobs === null || row.refundedJobs === null) return "no recorded jobs"
  const total = row.completedJobs + row.refundedJobs
  if (total === 0) return "no recorded jobs"
  return `${row.completedJobs} of ${total} delivered`
}
