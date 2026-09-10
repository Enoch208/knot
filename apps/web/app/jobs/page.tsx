import type { Metadata } from "next"
import {
  UNAVAILABLE,
  jobRecords,
  jobRecordsSnapshot,
  operatorLabelOf,
  outcomeOf,
  tallyJobRecords,
} from "../../src/job-records"
import "../../src/styles/jobs.css"

export const metadata: Metadata = {
  title: "Job records — KNOT",
  description:
    "Every KNOT job with recorded on-chain evidence: what was delivered, what was paid, and what failed.",
}

const day = (value: string): string => value.slice(0, 10)

export default function JobRecordsPage() {
  const tally = tallyJobRecords(jobRecords)
  return (
    <div className="jobs-page">
      <a className="jobs-skip" href="#job-index">Skip to job index</a>
      <header className="jobs-topbar">
        <a className="jobs-brand" href="/">KNOT</a>
        <nav aria-label="Job records navigation">
          <a href="/marketplace">Marketplace</a>
          <a href="/evidence">Evidence</a>
          <a href="/demo">Verified quote</a>
        </nav>
      </header>

      <main id="job-index" className="jobs-shell">
        <div className="jobs-masthead">
          <p className="jobs-eyebrow">Job records · BSC testnet · chain 97</p>
          <h1>Every job we hold evidence for.</h1>
          <p className="jobs-lede">
            {tally.total} paid jobs, including the ones that failed. Each row links to the recorded lifecycle: the
            transactions, the hashes, and which wallet ended up with the escrow.
          </p>
        </div>

        <dl className="jobs-tally">
          <div>
            <dt>Jobs recorded</dt>
            <dd>{tally.total}</dd>
          </div>
          <div>
            <dt>Settled to provider</dt>
            <dd>{tally.settled}</dd>
          </div>
          <div>
            <dt>Disputed, refunded</dt>
            <dd>{tally.refunded}</dd>
          </div>
          <div>
            <dt>Expired, no delivery</dt>
            <dd>{tally.expiredWithoutDelivery}</dd>
          </div>
          <div>
            <dt>Escrow released</dt>
            <dd>{tally.providerReceivedDisplay ?? UNAVAILABLE}</dd>
          </div>
          <div>
            <dt>Escrow returned</dt>
            <dd>{tally.buyerRefundedDisplay ?? UNAVAILABLE}</dd>
          </div>
        </dl>

        <p className="jobs-note">
          Amounts are BSC testnet test tokens. They are not revenue, not dollars, and not a performance record.{" "}
          {tally.settled} of these jobs settled to the provider. {tally.refunded + tally.expiredWithoutDelivery} did
          not, and each of those is listed here with the same detail as the ones that worked.
        </p>

        <div className="jobs-table-wrap">
          <table className="jobs-table">
            <caption>
              Observations through {jobRecordsSnapshot.observationsThroughUtc.slice(0, 10)}, generated from{" "}
              {jobRecordsSnapshot.sources.length} evidence files.
            </caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Agent</th>
                <th scope="col">Operator</th>
                <th scope="col">Outcome</th>
                <th scope="col">Escrow</th>
                <th scope="col">Provider paid</th>
                <th scope="col">Buyer refunded</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {jobRecords.map((job) => {
                const outcome = outcomeOf(job)
                return (
                  <tr key={job.jobId}>
                    <th scope="row">
                      <a className="jobs-link jobs-mono" href={`/jobs/${job.jobId}`}>
                        #{job.jobId}
                      </a>
                    </th>
                    <td>
                      {job.agent.name ?? UNAVAILABLE}
                      <div className="jobs-agent jobs-mono">agent #{job.agent.agentId}</div>
                    </td>
                    <td>{operatorLabelOf(job)}</td>
                    <td>
                      <span className={`jobs-badge is-${outcome === null ? "unknown" : outcome.tone}`}>
                        {outcome?.label ?? job.settlement.terminalState}
                      </span>
                    </td>
                    <td className="jobs-mono">{job.money.escrowDisplay ?? UNAVAILABLE}</td>
                    <td className="jobs-mono">{job.money.providerReceivedDisplay ?? UNAVAILABLE}</td>
                    <td className="jobs-mono">{job.money.buyerRefundedDisplay ?? UNAVAILABLE}</td>
                    <td className="jobs-mono">{day(job.recordedAtUtc)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <section className="jobs-sources" aria-label="Evidence sources">
          <p>Generated from the retained evidence files below. Nothing on this page is entered by hand.</p>
          <ul>
            {jobRecordsSnapshot.sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}
