import type { ReactNode } from "react"
import {
  UNAVAILABLE,
  explorerUrl,
  operatorLabelOf,
  outcomeOf,
  type JobRecord as JobRecordData,
} from "./job-records"
import "./styles/jobs.css"

const utc = (value: string | null): string | null =>
  value === null ? null : `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`

const abbreviate = (value: string): string =>
  value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="jobs-field">
      <dt>{label}</dt>
      <dd className={value === null ? "jobs-absent" : mono === true ? "jobs-mono" : undefined}>
        {value ?? UNAVAILABLE}
      </dd>
    </div>
  )
}

function HashField({ label, value }: { label: string; value: string | null }) {
  if (value === null) return <Field label={label} value={null} />
  return (
    <div className="jobs-field">
      <dt>{label}</dt>
      <dd className="jobs-mono" title={value}>
        {abbreviate(value)}
      </dd>
    </div>
  )
}

function DocumentField({ label, url }: { label: string; url: string | null }) {
  if (url === null) return <Field label={label} value={null} />
  return (
    <div className="jobs-field">
      <dt>{label}</dt>
      <dd>
        <a className="jobs-link" href={url} title={url} target="_blank" rel="noreferrer">
          Open retained artifact
        </a>
      </dd>
    </div>
  )
}

function Panel({ index, title, note, children }: { index: string; title: string; note: string; children: ReactNode }) {
  return (
    <section className="jobs-panel" aria-label={title}>
      <header>
        <span className="jobs-mono jobs-panel-index">{index}</span>
        <div>
          <h2>{title}</h2>
          <p>{note}</p>
        </div>
      </header>
      {children}
    </section>
  )
}

export default function JobRecordDetail({ job }: { job: JobRecordData }) {
  const outcome = outcomeOf(job)
  const tone = outcome === null ? "unknown" : outcome.tone
  return (
    <div className="jobs-page">
      <a className="jobs-skip" href="#job-record">Skip to job record</a>
      <header className="jobs-topbar">
        <a className="jobs-brand" href="/">KNOT</a>
        <nav aria-label="Job record navigation">
          <a href="/jobs">All job records</a>
          <a href="/marketplace">Marketplace</a>
          <a href="/evidence">Evidence</a>
        </nav>
      </header>

      <main id="job-record" className="jobs-shell">
        <div className="jobs-masthead">
          <p className="jobs-eyebrow">Job record · {job.network.name} · chain {job.network.chainId}</p>
          <h1>
            Job <span className="jobs-mono">#{job.jobId}</span>
          </h1>
          <p className="jobs-lede">
            {job.agent.name ?? UNAVAILABLE} · ERC-8004 agent <span className="jobs-mono">#{job.agent.agentId}</span> ·{" "}
            {operatorLabelOf(job)}
          </p>
          <p className={`jobs-badge is-${tone}`}>{outcome?.label ?? job.settlement.terminalState}</p>
        </div>

        <p className={`jobs-verdict is-${tone}`}>
          {outcome?.money ?? "This record has no recognised settlement classification."} The provider received{" "}
          <strong className="jobs-mono">{job.money.providerReceivedDisplay ?? UNAVAILABLE}</strong>. Terminal on-chain
          state: <strong className="jobs-mono">{job.settlement.terminalState}</strong>.
        </p>

        <div className="jobs-panels">
          <Panel index="01" title="Work state" note="What was produced, independent of who was paid.">
            <dl>
              <Field label="Deliverable submitted on chain" value={job.work.deliverySubmitted ? "Yes" : "No"} />
              <Field label="Artifact status" value={job.work.artifactStatus} />
              <Field label="Artifact reason code" value={job.work.artifactReasonCode} />
              <Field label="Declared category" value={job.agent.category} />
              <Field label="Declared capability" value={job.agent.capability} />
              <DocumentField label="Deliverable document" url={job.work.deliverableUrl} />
            </dl>
          </Panel>

          <Panel index="02" title="Money state" note="What moved on chain, independent of what was produced.">
            <dl>
              <Field label="Escrow funded" value={job.money.escrowDisplay} mono />
              <Field label="Provider received" value={job.money.providerReceivedDisplay} mono />
              <Field label="Buyer refunded" value={job.money.buyerRefundedDisplay} mono />
              <Field label="Payment token symbol" value={job.money.tokenSymbol} mono />
              <Field label="Buyer disputed" value={job.settlement.disputed ? "Yes" : "No"} />
              <Field label="Terminal protocol state" value={job.settlement.terminalState} mono />
            </dl>
          </Panel>

          <Panel index="03" title="Parties" note="Two separate wallets settle every job.">
            <dl>
              <Field label="Buyer wallet" value={job.parties.buyer} mono />
              <Field label="Provider wallet" value={job.parties.provider} mono />
              <Field label="Evaluator" value={job.parties.evaluator} mono />
              <Field label="Commerce contract" value={job.contracts.commerce} mono />
              <Field label="Payment token contract" value={job.contracts.paymentToken} mono />
              <Field label="Dispute policy" value={job.contracts.policy} mono />
              <Field
                label="Buyer and provider"
                value={job.parties.buyerIsProvider ? "Same wallet" : "Distinct wallets"}
              />
            </dl>
          </Panel>

          <Panel index="04" title="Bindings" note="Hashes that tie the request to the delivered bytes.">
            <dl>
              <HashField label="Task id" value={job.work.taskId} />
              <HashField label="Task input hash" value={job.work.taskInputHash} />
              <HashField label="Mainnet snapshot id" value={job.work.snapshotId} />
              <HashField label="Quote request hash" value={job.work.quoteRequestHash} />
              <HashField label="Negotiation hash" value={job.work.negotiationHash} />
              <HashField label="Deliverable manifest hash" value={job.work.deliverableManifestHash} />
              <HashField label="Deliverable SHA-256" value={job.work.deliverableSha256} />
            </dl>
          </Panel>
        </div>

        <section className="jobs-panel jobs-timeline" aria-label="Transaction timeline">
          <header>
            <span className="jobs-mono jobs-panel-index">05</span>
            <div>
              <h2>Recorded transactions</h2>
              <p>Every transaction this evidence file records, ordered by block number.</p>
            </div>
          </header>
          <ol>
            {job.transactions.map((transaction) => {
              const href = explorerUrl(job, transaction.hash)
              return (
                <li key={transaction.hash}>
                  <p className="jobs-step">{transaction.label}</p>
                  <p className="jobs-mono jobs-step-time">{utc(transaction.timestampUtc) ?? UNAVAILABLE}</p>
                  <p className="jobs-mono jobs-step-block">block {transaction.blockNumber}</p>
                  <p className="jobs-mono jobs-step-hash">
                    {href === null ? (
                      <span title={transaction.hash}>{abbreviate(transaction.hash)}</span>
                    ) : (
                      <a className="jobs-link" href={href} title={transaction.hash} target="_blank" rel="noreferrer">
                        {abbreviate(transaction.hash)}
                      </a>
                    )}
                  </p>
                  <p className={`jobs-receipt is-${transaction.receiptStatus === "success" ? "ok" : "other"}`}>
                    receipt {transaction.receiptStatus}
                  </p>
                </li>
              )
            })}
          </ol>
        </section>

        <section className="jobs-panel jobs-limits" aria-label="Recorded limitations">
          <header>
            <span className="jobs-mono jobs-panel-index">06</span>
            <div>
              <h2>Recorded limitations</h2>
              <p>Copied verbatim from the evidence file. Nothing here is softened.</p>
            </div>
          </header>
          {job.limitations.length === 0 ? (
            <p className="jobs-absent">{UNAVAILABLE}</p>
          ) : (
            <ul>
              {job.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          )}
        </section>

        <footer className="jobs-provenance">
          <p>
            Source <span className="jobs-mono">{job.sourcePath}</span>
          </p>
          <p>
            Observed <span className="jobs-mono">{utc(job.recordedAtUtc) ?? UNAVAILABLE}</span>
          </p>
        </footer>
      </main>
    </div>
  )
}
