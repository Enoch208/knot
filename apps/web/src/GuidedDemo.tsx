import Link from "next/link"
import { buildGuidedLifecycle, guidedJobIds, type GuidedJobKey } from "./guided-lifecycle"
import { findJobRecord, type JobRecord } from "./job-records"
import "./styles/guided-demo.css"

const options: readonly { key: GuidedJobKey; label: string; description: string }[] = [
  { key: "healthguard", label: "HealthGuard", description: "Lending health" },
  { key: "rangepilot", label: "RangePilot", description: "LP range analysis" },
  { key: "gridquant", label: "GridQuant", description: "Grid design" },
  { key: "yieldscout", label: "YieldScout", description: "Yield comparison" },
  { key: "refund", label: "Refund path", description: "Third-party expiry" },
]

const selectedKey = (jobId: string): GuidedJobKey =>
  options.find((option) => guidedJobIds[option.key] === jobId)?.key ?? "rangepilot"

const selectedRecord = (requestedJobId: string | undefined): JobRecord => {
  const allowed = new Set<string>(Object.values(guidedJobIds))
  const jobId = requestedJobId && allowed.has(requestedJobId) ? requestedJobId : guidedJobIds.rangepilot
  const job = findJobRecord(jobId)
  if (job === null) throw new Error(`Guided demo job ${jobId} is missing from the retained snapshot.`)
  return job
}

const shortDate = (value: string): string => `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`

const safeguards = [
  {
    title: "Wrong network",
    state: "Refused before signing",
    detail: "Every send checks for BSC testnet (97). A mismatched network cannot advance the saved hire.",
  },
  {
    title: "Wallet rejection",
    state: "Call not attempted",
    detail: "A rejected transaction request is saved as not attempted. Earlier confirmed calls remain visible.",
  },
  {
    title: "Quote expiry",
    state: "No additional call sent",
    detail: "Expiry and the safe funding window are checked again before every wallet request.",
  },
  {
    title: "Duplicate attempt",
    state: "Existing progress recovered",
    detail: "A browser lock and one journal per verified quote prevent parallel tabs from starting the same hire twice.",
  },
  {
    title: "Uncertain transaction hash",
    state: "Never automatically resent",
    detail: "The buyer can supply the wallet hash; KNOT accepts it only after the confirmed receipt matches the saved buyer, target and calldata.",
  },
  {
    title: "Reload recovery",
    state: "Saved receipt rechecked",
    detail: "Creation and funding progress is kept in browser storage and reconciled before another call can be requested.",
  },
] as const

export default function GuidedDemo({ requestedJobId }: { requestedJobId?: string }) {
  const job = selectedRecord(requestedJobId)
  const lifecycle = buildGuidedLifecycle(job)
  const active = selectedKey(job.jobId)
  const liveQuoteRoute = active === "refund" ? "/demo" : `/demo?agent=${active}`

  return (
    <div className="guided-page">
      <a className="guided-skip" href="#guided-lifecycle">Skip to lifecycle</a>
      <header className="guided-topbar">
        <Link className="guided-brand" href="/">KNOT</Link>
        <nav aria-label="Guided demo navigation">
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/jobs">Job records</Link>
          <Link href="/evidence">Evidence</Link>
        </nav>
      </header>

      <main className="guided-shell" id="guided-lifecycle">
        <section className="guided-hero">
          <div>
            <p className="guided-eyebrow">Guided demo · retained BSC testnet evidence</p>
            <h1>Follow the job.<br /><em>Keep every outcome visible.</em></h1>
            <p className="guided-lede">
              See how recorded funding becomes seller work, a verifiable artifact, and either settlement or a refund.
              This walkthrough reads completed evidence; it does not run transactions or replay a live job.
            </p>
          </div>
          <aside className="guided-disclosure">
            <span>Evidence mode</span>
            <strong>Retained, not simulated</strong>
            <p>Observed {shortDate(lifecycle.recordedAtUtc)}. Testnet tokens have no monetary value.</p>
          </aside>
        </section>

        <nav className="guided-picker" aria-label="Choose a retained job">
          {options.map((option) => (
            <Link
              aria-current={active === option.key ? "page" : undefined}
              className={active === option.key ? "is-active" : undefined}
              href={`/guided-demo?job=${guidedJobIds[option.key]}`}
              key={option.key}
            >
              <span>{option.label}</span>
              <small>{option.description}</small>
            </Link>
          ))}
        </nav>

        <section className="guided-record" aria-labelledby="guided-record-title">
          <header>
            <div>
              <p>Recorded job #{lifecycle.jobId}</p>
              <h2 id="guided-record-title">{lifecycle.agentName}</h2>
              <span>{lifecycle.operator}</span>
            </div>
            <strong className={`guided-outcome is-${lifecycle.terminalTone}`}>{lifecycle.terminalLabel}</strong>
          </header>

          <ol className="guided-timeline">
            {lifecycle.stages.map((stage, index) => (
              <li className={`is-${stage.state}`} key={stage.id}>
                <span className="guided-step">0{index + 1}</span>
                <div className="guided-stage-copy">
                  <p>{stage.label}</p>
                  <h3>{stage.summary}</h3>
                  <span>{stage.detail}</span>
                </div>
                {stage.transactionUrl && stage.transactionLabel ? (
                  <a href={stage.transactionUrl} target="_blank" rel="noreferrer">{stage.transactionLabel} ↗</a>
                ) : <span className="guided-unavailable">No supporting link</span>}
              </li>
            ))}
          </ol>

          <footer className="guided-receipt">
            <div>
              <span>Complete receipt</span>
              <p>Inspect parties, bindings, every recorded transaction, money state, and known limitations.</p>
            </div>
            <Link href={`/jobs/${lifecycle.jobId}`}>Open job #{lifecycle.jobId} receipt →</Link>
          </footer>
        </section>

        <section className="guided-boundary" aria-label="Live and retained boundaries">
          <div><span>Live now</span><strong>Agent cards and endpoint observations</strong><p>Current availability can be checked from each agent passport.</p></div>
          <div><span>Retained evidence</span><strong>This lifecycle and its receipts</strong><p>Historical observations are timestamped and never presented as a job running now.</p></div>
          <div><span>Optional next step</span><strong>Fresh specialist quote</strong><p>All four KNOT-operated quote paths are live and pre-funding; wallet approval is separate.</p><Link href={liveQuoteRoute}>Run verified quote →</Link></div>
        </section>

        <section className="guided-safeguards" aria-labelledby="guided-safeguards-title">
          <header>
            <p className="guided-eyebrow">Truthful failure states</p>
            <h2 id="guided-safeguards-title">A failed step stays failed.</h2>
            <span>These are enforced product behaviors, not events attributed to the selected retained job.</span>
          </header>
          <div className="guided-safeguard-grid">
            {safeguards.map((safeguard) => (
              <article key={safeguard.title}>
                <span>{safeguard.title}</span>
                <strong>{safeguard.state}</strong>
                <p>{safeguard.detail}</p>
              </article>
            ))}
            <article className="guided-timeout">
              <span>Seller timeout</span>
              <strong>Refund evidence available</strong>
              <p>
                Retained third-party job #1203 records no delivery before expiry and the full 0.1 testnet U escrow returned to the buyer.
                The current public hire panel does not itself expose the refund action.
              </p>
              <Link href={`/guided-demo?job=${guidedJobIds.refund}`}>Inspect the refund path →</Link>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}
