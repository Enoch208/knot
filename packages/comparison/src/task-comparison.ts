export type OperatorRelationship = "KNOT_OPERATED" | "EXTERNAL_DISTINCT_OWNER" | "UNVERIFIED"

export type CandidateAvailability = "CALLABLE" | "REGISTERED_ONLY" | "UNREACHABLE"

export type ComparisonOutcome =
  | "NO_COMPATIBLE_CANDIDATE"
  | "SINGLE_CANDIDATE"
  | "NOT_COMPARABLE"
  | "TIE"
  | "DECIDED"

export interface Candidate {
  key: string
  displayName: string
  category: string
  operatorRelationship: OperatorRelationship
  availability: CandidateAvailability
  priceBaseUnits: string | null
  currency: string | null
  quoteExpiresAtUnix: number | null
  completedJobs: number | null
  refundedJobs: number | null
  evidenceClass: string | null
}

export interface ComparableRow extends Candidate {
  eligible: boolean
  exclusionReason: string | null
}

export interface TaskComparison {
  taskCategory: string
  observedAtUnix: number
  outcome: ComparisonOutcome
  decisiveDimension: "price" | null
  recommendedKey: string | null
  operatorIndependence: "INDEPENDENT" | "SAME_OPERATOR" | "MIXED" | "NONE"
  rows: readonly ComparableRow[]
  limitations: readonly string[]
}

const isIntegerUnits = (value: string | null): value is string =>
  value !== null && /^[0-9]+$/.test(value) && BigInt(value) > 0n

function excludeReason(candidate: Candidate, taskCategory: string, nowUnix: number): string | null {
  if (candidate.category !== taskCategory) return "does not support this task category"
  if (candidate.availability === "UNREACHABLE") return "endpoint did not respond"
  if (candidate.availability === "REGISTERED_ONLY") return "registered but not callable for this task"
  if (!isIntegerUnits(candidate.priceBaseUnits)) return "no signed quote in integer base units"
  if (candidate.currency === null) return "quote did not name a payment currency"
  if (candidate.quoteExpiresAtUnix !== null && candidate.quoteExpiresAtUnix <= nowUnix) {
    return "signed quote expired before comparison"
  }
  return null
}

function independence(rows: readonly ComparableRow[]): TaskComparison["operatorIndependence"] {
  const eligible = rows.filter((row) => row.eligible)
  if (eligible.length === 0) return "NONE"
  const relationships = new Set(eligible.map((row) => row.operatorRelationship))
  if (relationships.size > 1) return "MIXED"
  return relationships.has("KNOT_OPERATED") ? "SAME_OPERATOR" : "INDEPENDENT"
}

export function compareCandidates(
  candidates: readonly Candidate[],
  taskCategory: string,
  nowUnix: number,
): TaskComparison {
  const rows: ComparableRow[] = candidates.map((candidate) => {
    const reason = excludeReason(candidate, taskCategory, nowUnix)
    return { ...candidate, eligible: reason === null, exclusionReason: reason }
  })

  const eligible = rows.filter((row) => row.eligible)
  const limitations: string[] = []
  const operatorIndependence = independence(rows)

  if (operatorIndependence === "SAME_OPERATOR" && eligible.length > 1) {
    limitations.push(
      "every eligible candidate is operated by KNOT; this compares implementations, not independent businesses",
    )
  }

  const currencies = new Set(eligible.map((row) => row.currency))
  if (currencies.size > 1) {
    limitations.push("eligible candidates quoted in different currencies; prices are not comparable")
  }

  const base = {
    taskCategory,
    observedAtUnix: nowUnix,
    operatorIndependence,
    rows,
  }

  if (eligible.length === 0) {
    return {
      ...base,
      outcome: "NO_COMPATIBLE_CANDIDATE",
      decisiveDimension: null,
      recommendedKey: null,
      limitations: [...limitations, "no candidate passed the eligibility checks for this task"],
    }
  }

  if (eligible.length === 1) {
    const only = eligible[0]
    return {
      ...base,
      outcome: "SINGLE_CANDIDATE",
      decisiveDimension: null,
      recommendedKey: only?.key ?? null,
      limitations: [...limitations, "only one candidate was eligible; this is not a comparison"],
    }
  }

  if (currencies.size > 1) {
    return {
      ...base,
      outcome: "NOT_COMPARABLE",
      decisiveDimension: null,
      recommendedKey: null,
      limitations,
    }
  }

  const prices = eligible.map((row) => BigInt(row.priceBaseUnits as string))
  const lowest = prices.reduce((left, right) => (right < left ? right : left))
  const cheapest = eligible.filter((row) => BigInt(row.priceBaseUnits as string) === lowest)

  if (cheapest.length > 1) {
    return {
      ...base,
      outcome: "TIE",
      decisiveDimension: null,
      recommendedKey: null,
      limitations: [...limitations, "eligible candidates quoted the same price; price does not separate them"],
    }
  }

  return {
    ...base,
    outcome: "DECIDED",
    decisiveDimension: "price",
    recommendedKey: cheapest[0]?.key ?? null,
    limitations: [
      ...limitations,
      "price is the only dimension compared; it does not measure delivered quality",
    ],
  }
}
