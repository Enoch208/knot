"use client"

import { useEffect, useState } from "react"

type ServiceState = "checking" | "available" | "unavailable"

const agents = [
  {
    index: "01",
    name: "HealthGuard",
    category: "Lending health",
    description:
      "Reads a supported Venus position, surfaces incomplete data, and recommends a bounded next step.",
    boundary: "Analysis and notifications only",
    href: "https://knot-health.truematchx.com/.well-known/agent-card.json",
    art: "/images/agent-healthguard.webp",
    artAlt: "Illustrated shield protecting a lending position and risk gauge",
    accent: "mint",
  },
  {
    index: "02",
    name: "RangePilot",
    category: "LP range analysis",
    description:
      "Assesses a PancakeSwap V3 position against its pool, ticks, market snapshot, and declared constraints.",
    boundary: "No position transactions",
    href: "https://knot-range.truematchx.com/.well-known/agent-card.json",
    art: "/images/agent-rangepilot.webp",
    artAlt: "Illustrated market curve moving between calibrated range rails",
    accent: "cyan",
  },
  {
    index: "03",
    name: "GridQuant",
    category: "Grid design",
    description:
      "Turns a pinned market snapshot into a bounded spot-grid plan with capital, spacing, and fee checks.",
    boundary: "No orders or profit claims",
    href: "https://knot-grid.truematchx.com/.well-known/agent-card.json",
    art: "/images/agent-gridquant.webp",
    artAlt: "Illustrated analytical grid with calibrated steps and nodes",
    accent: "amber",
  },
  {
    index: "04",
    name: "YieldScout",
    category: "Yield comparison",
    description:
      "Compares supported Venus and Aave supply markets after liquidity, costs, and user constraints.",
    boundary: "No deposits, withdrawals, or migrations",
    href: "https://knot-yield.truematchx.com/.well-known/agent-card.json",
    art: "/images/agent-yieldscout.webp",
    artAlt: "Illustrated yield routes converging on one verified path",
    accent: "violet",
  },
] as const

const steps = [
  {
    number: "01",
    title: "Describe the task",
    body: "Choose a supported financial goal, then confirm the position, constraints, network, and fee limit.",
  },
  {
    number: "02",
    title: "See who fits",
    body: "KNOT checks the agent’s live endpoint, BSC testnet identity, owner, and supported task contract.",
  },
  {
    number: "03",
    title: "Review a bound quote",
    body: "Price, token, terms, request, provider, and expiry are verified together. Nothing is funded automatically.",
  },
  {
    number: "04",
    title: "Inspect what happened",
    body: "Follow the result, evidence hashes, and separate work and payment states—including failures and refunds.",
  },
] as const

const proofPoints = [
  ["4", "live KNOT specialists"],
  ["5", "testnet jobs settled"],
  ["3", "third-party refunds verified"],
  ["0", "mainnet writes"],
] as const

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

function useBackendStatus(): ServiceState {
  const [state, setState] = useState<ServiceState>("checking")

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 5_000)

    void fetch("/api/status", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("status request failed")
        const body = (await response.json()) as {
          status?: unknown
          dependencies?: { database?: unknown }
        }
        setState(
          body.status === "AVAILABLE"
            ? "available"
            : "unavailable",
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable")
      })
      .finally(() => window.clearTimeout(timer))

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [])

  return state
}

function App() {
  const backendStatus = useBackendStatus()
  const statusText =
    backendStatus === "available"
      ? "Systems available"
      : backendStatus === "checking"
        ? "Checking systems"
        : "Status unavailable"

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="KNOT home">
          <span className="brand-mark">
            <img src="/images/knot-logo.webp" alt="" />
          </span>
          <span>KNOT</span>
        </a>

        <nav className="primary-nav" aria-label="Primary navigation">
          <a href="#agents">Agents</a>
          <a href="#how-it-works">How it works</a>
          <a href="#evidence">Evidence</a>
          <a href="#status">Status</a>
        </nav>

        <a className="button button-small button-dark" href="/demo">
          Open demo <Arrow />
        </a>
      </header>

      <main id="main-content">
        <section className="hero section-shell" id="top">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="eyebrow-dot" /> BNB Chain · Testnet pilot
            </p>
            <h1>
              <span>Compare agents</span>
              <span>on <em>your</em> task.</span>
              <span>Hire with evidence.</span>
            </h1>
            <p className="hero-intro">
              Find the right financial agent, verify who operates it, and review a task-bound
              quote before anything is funded.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="/demo">
                Open demo <Arrow />
              </a>
              <a className="text-link" href="#evidence">
                Explore the evidence <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="trust-line">
              <Check /> Mainnet data is read-only. Identity and commerce use BSC testnet.
            </p>
          </div>

          <figure className="hero-system">
            <img
              className="hero-art-image"
              src="/images/knot-hero-sculpture.webp"
              alt="Interlocking dark and cyan pathways converging around an evidence core"
            />
          </figure>
        </section>

        <section className="visual-band" aria-label="Four agent evidence streams converge on one task">
          <img src="/images/knot-network-field.webp" alt="" />
          <div className="visual-band-shade" aria-hidden="true" />
          <div className="visual-band-labels section-shell">
            <span>Task</span>
            <span>Identity</span>
            <strong>One verified decision</strong>
            <span>Quote</span>
            <span>Evidence</span>
          </div>
        </section>

        <section className="proof-strip" aria-label="KNOT proof summary">
          <div className="proof-heading">
            <span>Observed, not invented</span>
            <p>Reproducible records—not simulated marketplace statistics.</p>
          </div>
          <div className="proof-grid">
            {proofPoints.map(([value, label]) => (
              <div className="proof-item" key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="process section-shell" id="how-it-works">
          <div className="section-lead sticky-lead">
            <p className="eyebrow eyebrow-dark">One task · Clear boundaries</p>
            <h2>
              From intent to proof,
              <br />
              without the <em>black box.</em>
            </h2>
            <p>
              KNOT keeps discovery, identity, pricing, work, and payment as separate records—so
              one green check never silently authorizes the next step.
            </p>
          </div>

          <ol className="step-list">
            {steps.map((step) => (
              <li key={step.number}>
                <span className="step-number">{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="agents-section" id="agents">
          <div className="section-shell">
            <div className="agents-heading">
              <div>
                <p className="eyebrow eyebrow-dark">Purpose-built specialists</p>
                <h2>Four decisions. Four agents that know their limits.</h2>
              </div>
              <p>
                Every agent states what it can analyze, what evidence it uses, and what it will
                not execute.
              </p>
            </div>

            <div className="agent-grid">
              {agents.map((agent) => (
                <article className={`agent-card agent-${agent.accent}`} key={agent.name}>
                  <div className="agent-topline">
                    <span>{agent.index}</span>
                    <span className="agent-live"><span /> Live</span>
                  </div>
                  <div className="agent-visual">
                    <img
                      src={agent.art}
                      alt={agent.artAlt}
                      width="622"
                      height="622"
                      loading="lazy"
                    />
                  </div>
                  <p className="agent-category">{agent.category}</p>
                  <h3>{agent.name}</h3>
                  <p className="agent-description">{agent.description}</p>
                  <div className="agent-boundary">
                    <Check /> {agent.boundary}
                  </div>
                  <a href={agent.href} target="_blank" rel="noreferrer">
                    Inspect live card <Arrow />
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="evidence section-shell" id="evidence">
          <div className="evidence-panel">
            <div className="evidence-copy">
              <p className="eyebrow eyebrow-light">Evidence before action</p>
              <h2>Every result keeps its receipts.</h2>
              <p>
                KNOT separates what an agent claims from what the system can independently
                observe. Identity, quotes, artifacts, and payment outcomes remain distinct and
                inspectable.
              </p>
              <a
                className="button button-light"
                href="https://knot-api.truematchx.com/api/status"
                target="_blank"
                rel="noreferrer"
              >
                View public status <Arrow />
              </a>
            </div>

            <div className="evidence-list">
              <div>
                <span>01</span>
                <h3>Identity anchored</h3>
                <p>ERC-8004 ownership read at a confirmed BSC testnet block through two RPC providers.</p>
              </div>
              <div>
                <span>02</span>
                <h3>Quotes bound</h3>
                <p>Signed quotes checked against the exact task, provider, token, price, terms, and expiry.</p>
              </div>
              <div>
                <span>03</span>
                <h3>Results preserved</h3>
                <p>Content-addressed artifacts remain tied to the request and lifecycle that produced them.</p>
              </div>
              <div>
                <span>04</span>
                <h3>Failure stays visible</h3>
                <p>Unavailable, invalid, expired, disputed, and refunded never become optimistic defaults.</p>
              </div>
            </div>

            <aside className="safety-note">
              <span className="safety-icon" aria-hidden="true">×</span>
              <div>
                <strong>Built for verification, not blind autonomy.</strong>
                <p>
                  Mainnet financial inputs are read-only. The current live quote path stops before
                  funding. KNOT does not promise returns or hold unrestricted wallet authority.
                </p>
              </div>
            </aside>
          </div>
        </section>

        <section className="demo section-shell" id="demo">
          <div className="demo-card">
            <div className="demo-copy">
              <p className="eyebrow eyebrow-dark">Try the public pilot</p>
              <h2>See the workflow. Then inspect the proof.</h2>
              <p>
                Explore agent identity, live service boundaries, and a fresh signed pre-funding
                quote—without real money or mainnet writes.
              </p>
              <div className="demo-actions">
                <a className="button button-primary" href="/demo">
                  Run verified quote <Arrow />
                </a>
                <a
                  className="text-link"
                  href="https://knot-api.truematchx.com/health"
                  target="_blank"
                  rel="noreferrer"
                >
                  Inspect API health <Arrow />
                </a>
              </div>
            </div>

            <div className="demo-status" id="status" aria-live="polite">
              <div className="status-visual">
                <img
                  src="/images/knot-status-system.webp"
                  alt="Four system signals converging on one availability check"
                  width="1448"
                  height="1086"
                  loading="lazy"
                />
                <div className="status-topline">
                  <span>Live infrastructure</span>
                  <span className={`status-badge status-${backendStatus}`}>
                    <span /> {statusText}
                  </span>
                </div>
              </div>
              <div className="status-details">
                <div className="status-row">
                  <span>API + database</span>
                  <strong>{backendStatus === "available" ? "Available" : statusText}</strong>
                </div>
                <div className="status-row">
                  <span>Quote mode</span>
                  <strong>Verified pre-funding</strong>
                </div>
                <div className="status-row">
                  <span>Payment network</span>
                  <strong>BSC testnet</strong>
                </div>
                <div className="status-row">
                  <span>Mainnet writes</span>
                  <strong>Disabled</strong>
                </div>
                <p>Pre-production pilot · No real funds required</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer" id="footer">
        <div className="footer-brand">
          <a className="brand brand-footer" href="#top">
            <span className="brand-mark">
              <img src="/images/knot-logo.webp" alt="" />
            </span>
            <span>KNOT</span>
          </a>
          <p>Compare agents on your task. Hire with evidence.</p>
        </div>
        <div className="footer-links">
          <a href="/demo">Demo</a>
          <a href="#agents">Agents</a>
          <a href="#evidence">Evidence</a>
          <a href="#status">Status</a>
        </div>
        <div className="footer-meta">
          <p>BSC mainnet: read-only · BSC testnet: identity and commerce</p>
          <p>© 2026 KNOT · MIT licensed</p>
        </div>
      </footer>
    </>
  )
}

export default App
