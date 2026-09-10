"use client"

import { useState } from "react"

type DemoState = "idle" | "running" | "complete" | "failed"

type QuoteResult = {
  stage: "VERIFIED_PRE_FUNDING"
  mode: "QUOTE_ONLY"
  agent: {
    name: string
    relation: string
    endpoint: string
    agentId: string
  }
  task: {
    id: string
    serviceRequestId: string
    category: string
    capability: string
    targetRangeWidthTicks: number
    maximumSlippageBps: number
    snapshotBlock: string
    snapshotObservedAt: string
    inputHash: string
  }
  identity: {
    chainId: number
    registry: string
    agentId: string
    owner: string
    blockNumber: string
    blockHash: string
    observedAt: string
    confirmation: string
  }
  quote: {
    priceUnits: string
    token: string
    decimals: number
    deliverables: string
    qualityStandards: string
    expiresAtUnix: string
    expired: boolean
    verifiedAt: string
    negotiationHash: string
    requestHash: string
    responseHash: string
    signatureMethod: string
  }
  lifecycle: {
    taskStatus: number
    serviceRequestStatus: number
    quoteStatus: number
  }
  boundary: {
    fundingPermitted: false
    walletAccessed: false
    jobCreated: false
    chainWritePerformed: false
    mainnetWritePerformed: false
  }
}

const Arrow = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
    <path d="M5 15 15 5M7 5h8v8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
  </svg>
)

const Check = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
    <path d="m4.5 10.4 3.2 3.2 7.8-8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </svg>
)

function compact(value: string, head = 10, tail = 8) {
  return value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value
}

function formatTime(value: string | number) {
  const milliseconds = typeof value === "number" ? value * 1_000 : Date.parse(value)
  return Number.isFinite(milliseconds)
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(milliseconds) + " UTC"
    : "Unavailable"
}

function formatTokenAmount(units: string, decimals: number) {
  if (!/^\d+$/.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return "Unavailable"
  }
  if (decimals === 0) return BigInt(units).toString()
  const padded = units.padStart(decimals + 1, "0")
  const whole = padded.slice(0, -decimals) || "0"
  const fraction = padded.slice(-decimals).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

export default function DemoExperience() {
  const [state, setState] = useState<DemoState>("idle")
  const [width, setWidth] = useState(1200)
  const [slippage, setSlippage] = useState(50)
  const [result, setResult] = useState<QuoteResult | null>(null)
  const [error, setError] = useState("")

  const runDemo = async () => {
    setState("running")
    setError("")
    setResult(null)
    try {
      const response = await fetch("/api/demo/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetRangeWidthTicks: width,
          maximumSlippageBps: slippage,
        }),
      })
      const body = await response.json() as QuoteResult | { explanation?: unknown }
      if (!response.ok || !("stage" in body)) {
        const failure = body as { explanation?: unknown }
        throw new Error(
          typeof failure.explanation === "string"
            ? failure.explanation
            : "The verified quote service is unavailable.",
        )
      }
      setResult(body)
      setState("complete")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The verified quote service is unavailable.")
      setState("failed")
    }
  }

  return (
    <div className="demo-page">
      <a className="skip-link" href="#demo-workspace">Skip to demo</a>
      <header className="demo-header">
        <a className="brand" href="/" aria-label="KNOT home">
          <span className="brand-mark"><img src="/images/knot-logo.webp" alt="" /></span>
          <span>KNOT</span>
        </a>
        <div className="demo-header-note">
          <span className="live-dot" /> Live verified-quote path
        </div>
        <a className="demo-back" href="/">Back to overview <span aria-hidden="true">↗</span></a>
      </header>

      <main id="demo-workspace" className="demo-workspace">
        <section className="demo-intro">
          <p className="eyebrow eyebrow-dark">Safe example · No wallet required</p>
          <h1>Review the task.<br />Verify the <em>quote.</em></h1>
          <p>
            Adjust two bounded inputs, then ask RangePilot for a newly verified quote. KNOT
            checks the agent’s testnet identity and signature before showing it to you.
          </p>
        </section>

        <div className="demo-layout">
          <section className="demo-config" aria-labelledby="demo-config-title">
            <div className="demo-section-heading">
              <span>01</span>
              <div>
                <p>Configure the example</p>
                <h2 id="demo-config-title">LP range analysis</h2>
              </div>
            </div>

            <article className="selected-agent">
              <img src="/images/agent-rangepilot.webp" alt="" />
              <div>
                <p>Selected specialist</p>
                <h3>RangePilot</h3>
                <span>ERC-8004 agent 2297 · KNOT-operated</span>
              </div>
              <strong><span /> Live</strong>
            </article>

            <div className="example-notice">
              <span>Read-only example</span>
              <p>
                A retained PancakeSwap V3 position snapshot on BSC mainnet is used so this run is
                reproducible. The quote itself uses BSC testnet identity and payment terms.
              </p>
            </div>

            <div className="demo-fields">
              <label>
                <span>Target range width</span>
                <small>How wide the analysis window should be</small>
                <select value={width} onChange={(event) => setWidth(Number(event.target.value))} disabled={state === "running"}>
                  <option value="600">Focused · 600 ticks</option>
                  <option value="1200">Balanced · 1,200 ticks</option>
                  <option value="2400">Broad · 2,400 ticks</option>
                </select>
              </label>
              <label>
                <span>Maximum slippage</span>
                <small>A declared limit—never permission to transact</small>
                <select value={slippage} onChange={(event) => setSlippage(Number(event.target.value))} disabled={state === "running"}>
                  <option value="25">Conservative · 0.25%</option>
                  <option value="50">Standard · 0.50%</option>
                  <option value="75">Flexible · 0.75%</option>
                </select>
              </label>
            </div>

            <button className="button button-primary demo-run" type="button" onClick={runDemo} disabled={state === "running"}>
              {state === "running" ? "Verifying live quote…" : state === "complete" ? "Run another quote" : "Request verified quote"}
              {state === "running" ? <span className="button-spinner" /> : <Arrow />}
            </button>
            <p className="demo-consent"><Check /> This action creates no job, accesses no wallet, and moves no funds.</p>
          </section>

          <section className={`demo-output output-${state}`} aria-live="polite" aria-busy={state === "running"}>
            <div className="demo-section-heading demo-output-heading">
              <span>02</span>
              <div>
                <p>Verification result</p>
                <h2>{state === "complete" ? "Quote ready for review" : "Evidence appears here"}</h2>
              </div>
            </div>

            {state === "idle" && (
              <div className="output-idle">
                <div className="idle-orbit" aria-hidden="true"><span /><span /><span /></div>
                <h3>Nothing has been requested yet.</h3>
                <p>KNOT will keep task, identity, quote and funding as four separate checks.</p>
                <ol>
                  <li><span>1</span> Bind the exact task</li>
                  <li><span>2</span> Observe agent identity</li>
                  <li><span>3</span> Verify the signed quote</li>
                  <li><span>4</span> Stop before funding</li>
                </ol>
              </div>
            )}

            {state === "running" && (
              <div className="output-running">
                <div className="verification-pulse"><span /></div>
                <h3>Checking live evidence</h3>
                <p>Binding the request, observing ERC-8004 ownership through two RPC providers, and recovering the quote signer.</p>
                <div className="running-lines"><span /><span /><span /></div>
              </div>
            )}

            {state === "failed" && (
              <div className="output-failed">
                <span className="failure-mark">×</span>
                <p className="result-kicker">Failed closed · Unfunded</p>
                <h3>The quote was not shown as verified.</h3>
                <p>{error}</p>
                <strong>No wallet was accessed and no funds moved.</strong>
              </div>
            )}

            {state === "complete" && result && (
              <div className="quote-result">
                <div className="quote-verdict">
                  <span className="verified-mark"><Check /></span>
                  <div>
                    <p className="result-kicker">Cryptographically verified</p>
                    <h3>{formatTokenAmount(result.quote.priceUnits, result.quote.decimals)} testnet U</h3>
                    <p>Expires {formatTime(Number(result.quote.expiresAtUnix))}</p>
                  </div>
                  <span className="prefund-pill">Pre-funding</span>
                </div>

                <div className="result-grid">
                  <div>
                    <span>Agent identity</span>
                    <strong>ERC-8004 #{result.identity.agentId}</strong>
                    <code title={result.identity.owner}>{compact(result.identity.owner)}</code>
                  </div>
                  <div>
                    <span>Observed block</span>
                    <strong>BSC testnet · {result.identity.blockNumber}</strong>
                    <code title={result.identity.blockHash}>{compact(result.identity.blockHash)}</code>
                  </div>
                  <div>
                    <span>Task binding</span>
                    <strong>{result.task.targetRangeWidthTicks.toLocaleString()} ticks · {(result.task.maximumSlippageBps / 100).toFixed(2)}%</strong>
                    <code title={result.task.inputHash}>{compact(result.task.inputHash)}</code>
                  </div>
                  <div>
                    <span>Negotiation proof</span>
                    <strong>EIP-191 recovered</strong>
                    <code title={result.quote.negotiationHash}>{compact(result.quote.negotiationHash)}</code>
                  </div>
                </div>

                <div className="deliverable-note">
                  <span>Promised deliverable</span>
                  <p>{result.quote.deliverables}</p>
                </div>

                <div className="boundary-grid">
                  <div><Check /><span>Identity observed</span></div>
                  <div><Check /><span>Quote signature verified</span></div>
                  <div><span className="boundary-stop">×</span><span>Funding disabled</span></div>
                  <div><span className="boundary-stop">×</span><span>Mainnet writes disabled</span></div>
                </div>

                <div className="quote-meta">
                  <span>Verified {formatTime(result.quote.verifiedAt)}</span>
                  <a href={result.agent.endpoint + "/.well-known/agent-card.json"} target="_blank" rel="noreferrer">
                    Inspect agent card <Arrow />
                  </a>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="demo-boundary">
          <span>03</span>
          <div>
            <p>What this demo proves</p>
            <h2>Verification before authorization.</h2>
          </div>
          <p>
            This is a genuine seller negotiation and confirmed BSC testnet identity observation.
            It is not a payment, delivery, investment recommendation, or promise of performance.
          </p>
        </section>
      </main>

      <footer className="demo-page-footer">
        <p>KNOT · Pre-production testnet pilot</p>
        <p>BSC mainnet data: read-only · BSC testnet: identity and quote terms</p>
      </footer>
    </div>
  )
}
