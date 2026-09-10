import type { Metadata } from "next"
import { agentProfiles } from "../../src/agent-catalog"

export const metadata: Metadata = {
  title: "Evidence Lab — KNOT",
  description:
    "Inspect KNOT's retained paid comparisons, measured Shield evaluation, and verified testnet refund records.",
}

const experiments = [
  {
    slug: "healthguard",
    experiment: "healthguard-1185",
    job: "1185",
    dimensions: "4 / 4",
    binding: "Partial",
    lifecycle: "43.6 s",
    fee: "0.1 U",
    network: "0.002555089 tBNB",
    note: "Both paths share the retained SHA-256-bound input, but the signed task preimage is not claimed.",
  },
  {
    slug: "rangepilot",
    experiment: "rangepilot-1189",
    job: "1189",
    dimensions: "6 / 6",
    binding: "Exact",
    lifecycle: "203.4 s",
    fee: "0.1 U",
    network: "0.002078536 tBNB",
    note: "The signed TaskSpec input hash matches the retained raw input bytes.",
  },
  {
    slug: "gridquant",
    experiment: "gridquant-1187",
    job: "1187",
    dimensions: "5 / 5",
    binding: "Exact",
    lifecycle: "93.6 s",
    fee: "0.1 U",
    network: "0.001783262 tBNB",
    note: "The signed TaskSpec input hash matches the retained raw input bytes.",
  },
  {
    slug: "yieldscout",
    experiment: "yieldscout-1188",
    job: "1188",
    dimensions: "5 / 5",
    binding: "Exact",
    lifecycle: "148.4 s",
    fee: "0.1 U",
    network: "0.002168994 tBNB",
    note: "The signed TaskSpec input hash matches the retained raw input bytes.",
  },
] as const

const refundRecords = [
  { job: "1191", amount: "0.01 U" },
  { job: "1198", amount: "0.1 U" },
  { job: "1203", amount: "0.1 U" },
] as const

const Arrow = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
    <path d="M5 15 15 5M7 5h8v8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
  </svg>
)

export default function EvidencePage() {
  return (
    <div className="evidence-page">
      <a className="skip-link" href="#evidence-main">Skip to evidence</a>
      <header className="evidence-header">
        <a className="brand" href="/" aria-label="KNOT home">
          <span className="brand-mark"><img src="/images/knot-logo.webp" alt="" /></span>
          <span>KNOT</span>
        </a>
        <nav aria-label="Evidence navigation">
          <a href="#comparisons">Comparisons</a>
          <a href="#shield">Shield</a>
          <a href="#recovery">Recovery</a>
        </nav>
        <a className="button button-small button-dark" href="/marketplace">Open marketplace <Arrow /></a>
      </header>

      <main id="evidence-main">
        <section className="evidence-hero">
          <div className="evidence-hero-copy">
            <p className="eyebrow eyebrow-dark">KNOT Evidence Lab · retained observations</p>
            <h1>Show the record.<br />Keep the <em>limits.</em></h1>
            <p>
              Paid testnet work, independently recomputed comparisons, measured misses, and exact
              refunds—presented without turning a single observation into a performance promise.
            </p>
          </div>
          <div className="evidence-orbit" aria-label="Four retained agent records converge on one transparent evidence record">
            <div className="evidence-orbit-core">
              <span>Retained</span>
              <strong>4 × paid</strong>
              <small>testnet records</small>
            </div>
            <span className="orbit-node orbit-node-one">Task</span>
            <span className="orbit-node orbit-node-two">Result</span>
            <span className="orbit-node orbit-node-three">Cost</span>
            <span className="orbit-node orbit-node-four">Limits</span>
          </div>
        </section>

        <section className="evidence-summary" aria-label="Evidence summary">
          <div><strong>4</strong><span>paid comparison pairs</span></div>
          <div><strong>4</strong><span>honest quality ties</span></div>
          <div><strong>3</strong><span>exact task bindings</span></div>
          <div><strong>0</strong><span>mainnet writes</span></div>
        </section>

        <section className="comparison-section evidence-shell" id="comparisons">
          <div className="evidence-section-heading">
            <div>
              <p className="eyebrow eyebrow-dark">01 · Paired marketplace experiments</p>
              <h2>Same task in.<br />No invented win out.</h2>
            </div>
            <p>
              Each KNOT-operated agent and its reference implementation were scored from the same
              frozen input. All four tied on every measured quality dimension. These are single-input
              observations, not proof of superiority or repeatability.
            </p>
          </div>

          <div className="comparison-grid">
            {experiments.map((experiment, index) => {
              const profile = agentProfiles.find((item) => item.slug === experiment.slug)!
              return (
                <article className={`comparison-card comparison-${profile.accent}`} key={experiment.experiment}>
                  <div className="comparison-card-head">
                    <span>0{index + 1}</span>
                    <span className="evidence-pill">Paid · testnet</span>
                  </div>
                  <img src={profile.art} alt="" width="240" height="240" />
                  <p>{profile.category}</p>
                  <h3>{profile.name}</h3>
                  <div className="tie-result">
                    <span>Measured quality</span>
                    <strong>Tie</strong>
                    <small>{experiment.dimensions} dimensions tied</small>
                  </div>
                  <dl>
                    <div><dt>Experiment</dt><dd>{experiment.experiment}</dd></div>
                    <div><dt>Task binding</dt><dd>{experiment.binding}</dd></div>
                    <div><dt>Service fee</dt><dd>{experiment.fee}</dd></div>
                    <div><dt>Network fee</dt><dd>{experiment.network}</dd></div>
                    <div><dt>Paid lifecycle</dt><dd>{experiment.lifecycle}</dd></div>
                  </dl>
                  <p className="comparison-note">{experiment.note}</p>
                  <a href={`/agents/${profile.slug}`}>Inspect agent passport <Arrow /></a>
                </article>
              )
            })}
          </div>

          <aside className="comparison-boundary">
            <span>Timing boundary</span>
            <p>
              Paid lifecycle durations include marketplace steps. Baseline timings measure calculation
              only, so KNOT does not claim a speed, labor, latency, or cost advantage from these records.
            </p>
          </aside>
        </section>

        <section className="shield-section" id="shield">
          <div className="evidence-shell shield-layout">
            <div className="shield-copy">
              <p className="eyebrow eyebrow-light">02 · Shield measured evaluation</p>
              <h2>Precision without hiding the misses.</h2>
              <p>
                Shield was measured on six small, synthetic, team-owned smart-contract fixtures using
                Slither 0.11.3 with 100 detectors and solc 0.8.28. The corpus is useful for debugging;
                it is not comprehensive audit evidence.
              </p>
              <div className="shield-tooling">
                <span>Frozen rules</span><span>6 fixtures</span><span>1 holdout</span><span>Team-owned labels</span>
              </div>
            </div>

            <div className="shield-scorecard">
              <div className="shield-primary">
                <span>Recall</span>
                <strong>22.2%</strong>
                <p>2 of 9 labeled findings detected</p>
              </div>
              <div className="shield-secondary">
                <div><span>True positives</span><strong>2</strong></div>
                <div><span>False positives</span><strong>0</strong></div>
                <div className="shield-miss"><span>False negatives</span><strong>7</strong></div>
                <div><span>Holdout detected</span><strong>0 / 3</strong></div>
              </div>
              <p className="shield-warning">
                High precision here means both reported in-scope findings were valid. It does not
                offset seven misses or establish general security coverage.
              </p>
            </div>
          </div>
        </section>

        <section className="recovery-section evidence-shell" id="recovery">
          <div className="evidence-section-heading">
            <div>
              <p className="eyebrow eyebrow-dark">03 · Failure and recovery</p>
              <h2>When delivery fails,<br /><em>the failure stays visible.</em></h2>
            </div>
            <p>
              Three paid third-party testnet jobs were acknowledged but produced no deliverable before
              expiry. Each used a separate buyer and distinct-owner seller; each payment was returned
              exactly. This proves recovery behavior—not seller hireability.
            </p>
          </div>

          <div className="refund-ledger" role="table" aria-label="Verified refund records">
            <div className="refund-ledger-head" role="row">
              <span role="columnheader">Job</span><span role="columnheader">Work state</span>
              <span role="columnheader">Payment state</span><span role="columnheader">Exact refund</span>
            </div>
            {refundRecords.map((record) => (
              <div className="refund-row" role="row" key={record.job}>
                <strong role="cell">#{record.job}</strong>
                <span role="cell"><i className="refund-dot refund-dot-failed" /> Expired · no deliverable</span>
                <span role="cell"><i className="refund-dot" /> Refunded</span>
                <strong role="cell">{record.amount}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="method-section">
          <div className="evidence-shell method-layout">
            <div>
              <p className="eyebrow eyebrow-light">Method and claim boundary</p>
              <h2>Evidence should narrow a claim—not decorate it.</h2>
            </div>
            <ul>
              <li>Finance inputs came from BSC mainnet observations; agents performed no mainnet writes.</li>
              <li>Identity, service fees, lifecycle transactions, settlements, and refunds used BSC testnet.</li>
              <li>Testnet U and tBNB are not revenue, dollars, or proof of production economics.</li>
              <li>No result establishes profit, APY, returns, savings, execution quality, or future performance.</li>
              <li>KNOT operates the four compared sellers and their reference implementations.</li>
            </ul>
            <div className="method-actions">
              <a className="button button-primary" href="/demo">Run a fresh quote <Arrow /></a>
              <a className="button button-outline-light" href="https://knot-api.truematchx.com/api/status" target="_blank" rel="noreferrer">Inspect public status <Arrow /></a>
            </div>
          </div>
        </section>
      </main>

      <footer className="demo-page-footer">
        <p>KNOT · Evidence Lab · Updated from retained records</p>
        <p>Mainnet data: read-only · Identity and commerce: BSC testnet</p>
      </footer>
    </div>
  )
}
