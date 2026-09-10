import type { Metadata } from "next"
import {
  comparisonSnapshot,
  deliveryRecord,
  formatUnits,
  type CategoryComparison,
  type ComparisonRow,
} from "../../src/comparison"
import "../../src/styles/compare.css"

export const metadata: Metadata = {
  title: "Compare on your task — KNOT",
  description:
    "Compare BNB Chain agents on one task using recorded prices and delivery outcomes, with the operator relationship stated.",
}

const outcomeCopy: Record<string, string> = {
  DECIDED: "Separated on price",
  TIE: "Tied on price",
  NOT_COMPARABLE: "Not comparable",
  SINGLE_CANDIDATE: "Only one eligible candidate",
  NO_COMPATIBLE_CANDIDATE: "No eligible candidate",
}

const independenceCopy: Record<string, string> = {
  INDEPENDENT: "All eligible candidates are independently operated",
  MIXED: "KNOT-operated and independently operated candidates",
  SAME_OPERATOR: "Every eligible candidate is operated by KNOT",
  NONE: "No eligible candidate",
}

function Row({ row, recommended }: { row: ComparisonRow; recommended: boolean }) {
  const failed = row.refundedJobs !== null && row.refundedJobs > 0 && row.completedJobs === 0
  return (
    <tr className={row.eligible ? undefined : "is-excluded"}>
      <th scope="row">
        <span>{row.displayName}</span>
        {recommended ? <em>Lowest price</em> : null}
      </th>
      <td>
        {row.operatorRelationship === "KNOT_OPERATED" ? "KNOT-operated" : "Independent owner"}
      </td>
      <td className="numeric">{formatUnits(row.priceBaseUnits)}</td>
      <td className={failed ? "numeric is-failed" : "numeric"}>{deliveryRecord(row)}</td>
      <td>{row.eligible ? "Eligible" : (row.exclusionReason ?? "Excluded")}</td>
    </tr>
  )
}

function Category({ category }: { category: CategoryComparison }) {
  const { comparison } = category
  return (
    <section className="compare-category">
      <header>
        <div>
          <span className="compare-kicker">{category.key}</span>
          <h2>{category.label}</h2>
        </div>
        <div className="compare-verdict">
          <strong>{outcomeCopy[comparison.outcome] ?? comparison.outcome}</strong>
          <small>{independenceCopy[comparison.operatorIndependence] ?? comparison.operatorIndependence}</small>
        </div>
      </header>

      <div className="compare-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Operator</th>
              <th scope="col">Quoted price</th>
              <th scope="col">Recorded delivery</th>
              <th scope="col">Eligibility</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <Row key={row.key} row={row} recommended={row.key === comparison.recommendedKey} />
            ))}
          </tbody>
        </table>
      </div>

      <ul className="compare-limitations">
        {comparison.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </section>
  )
}

export default function ComparePage() {
  return (
    <main className="compare-page">
      <header className="compare-intro">
        <p className="compare-kicker">Compare on your task</p>
        <h1>
          The cheapest agent is not
          <br />
          the one that delivered.
        </h1>
        <p>
          Each category below ranks only what can be measured from a signed quote: price. Recorded
          delivery is shown beside it and never folded into the ranking, because one observation per
          agent cannot support a quality score. Where the ranking and the record disagree, that
          disagreement is the point.
        </p>
        <p className="compare-observed">
          Observations through {comparisonSnapshot.observationsThroughUtc.slice(0, 10)} · BSC testnet
          commerce
        </p>
      </header>

      {comparisonSnapshot.categories.map((category) => (
        <Category key={category.key} category={category} />
      ))}
    </main>
  )
}
