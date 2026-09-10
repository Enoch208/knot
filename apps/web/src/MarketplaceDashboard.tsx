"use client"

import { useMemo, useState } from "react"
import { agentProfiles } from "./agent-catalog"

type Category = "All agents" | "Lending" | "Liquidity" | "Trading" | "Yield"

const categories: readonly Category[] = ["All agents", "Lending", "Liquidity", "Trading", "Yield"]

const categoryBySlug = {
  healthguard: "Lending",
  rangepilot: "Liquidity",
  gridquant: "Trading",
  yieldscout: "Yield",
} as const

const activity = [
  { job: "#1189", agent: "RangePilot", state: "Settled", amount: "0.1 U", time: "Paid record" },
  { job: "#1188", agent: "YieldScout", state: "Settled", amount: "0.1 U", time: "Paid record" },
  { job: "#1187", agent: "GridQuant", state: "Settled", amount: "0.1 U", time: "Paid record" },
  { job: "#1185", agent: "HealthGuard", state: "Settled", amount: "0.1 U", time: "Paid record" },
] as const

const Icon = ({ name }: { name: "market" | "home" | "jobs" | "evidence" | "status" | "search" }) => {
  const paths = {
    home: <><path d="M3 10.5 10 4l7 6.5"/><path d="M5.5 9.5V17h9V9.5"/></>,
    market: <><path d="M3 7h14l-1-3H4L3 7Z"/><path d="M4 7v10h12V7"/><path d="M8 17v-5h4v5"/></>,
    jobs: <><rect x="4" y="5" width="12" height="12" rx="2"/><path d="M7 5V3h6v2M7 10h6M7 13h4"/></>,
    evidence: <><path d="M4 16V9M10 16V4M16 16v-7"/><path d="M2 17h16"/></>,
    status: <><circle cx="10" cy="10" r="7"/><path d="m7 10 2 2 4-5"/></>,
    search: <><circle cx="9" cy="9" r="5"/><path d="m13 13 4 4"/></>,
  }
  return <svg aria-hidden="true" viewBox="0 0 20 20">{paths[name]}</svg>
}

const Arrow = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 15 15 5M7 5h8v8" /></svg>
)

export default function MarketplaceDashboard() {
  const [category, setCategory] = useState<Category>("All agents")
  const [query, setQuery] = useState("")

  const visibleAgents = useMemo(() => {
    const term = query.trim().toLowerCase()
    return agentProfiles.filter((agent) => {
      const categoryMatches = category === "All agents" || categoryBySlug[agent.slug] === category
      const queryMatches = !term || `${agent.name} ${agent.category} ${agent.shortDescription}`.toLowerCase().includes(term)
      return categoryMatches && queryMatches
    })
  }, [category, query])

  return (
    <div className="market-app">
      <aside className="market-sidebar">
        <a className="market-brand" href="/" aria-label="KNOT home">
          <img src="/images/knot-logo.webp" alt="" />
          <span>KNOT</span>
        </a>

        <nav className="market-nav" aria-label="Marketplace navigation">
          <a href="/"><Icon name="home" /><span>Overview</span></a>
          <a className="is-active" href="/marketplace"><Icon name="market" /><span>Marketplace</span></a>
          <a href="#activity"><Icon name="jobs" /><span>Jobs</span><small>5</small></a>
          <a href="/evidence"><Icon name="evidence" /><span>Evidence</span></a>
        </nav>

        <div className="market-sidebar-foot">
          <div className="market-network"><span /><div><strong>BSC testnet</strong><small>Commerce online</small></div></div>
          <a href="https://knot-api.truematchx.com/api/status" target="_blank" rel="noreferrer"><Icon name="status" /> System status</a>
        </div>
      </aside>

      <main className="market-main">
        <header className="market-topbar">
          <div className="market-search">
            <Icon name="search" />
            <label htmlFor="agent-search" className="sr-only">Search agents</label>
            <input id="agent-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents or capabilities" />
            <kbd>⌘ K</kbd>
          </div>
          <div className="market-top-actions">
            <span className="market-readonly">Mainnet · read only</span>
            <a className="market-wallet" href="/demo"><span className="market-wallet-dot" /> Run live quote <Arrow /></a>
          </div>
        </header>

        <div className="market-content">
          <section className="market-welcome">
            <div>
              <p>Agent marketplace</p>
              <h1>Find the right specialist.<br /><em>Verify before you hire.</em></h1>
              <span>Four KNOT-operated agents. Mainnet financial data stays read-only; commerce stays on testnet.</span>
            </div>
            <div className="market-proof-seal">
              <span>Live system</span>
              <strong>4 / 4</strong>
              <small>agent endpoints available</small>
            </div>
          </section>

          <section className="market-stats" aria-label="Marketplace summary">
            <div><span>Available agents</span><strong>04</strong><small><i /> All endpoints live</small></div>
            <div><span>Settled records</span><strong>05</strong><small>BSC testnet</small></div>
            <div><span>Verified refunds</span><strong>03</strong><small>Exact testnet returns</small></div>
            <div><span>Mainnet writes</span><strong>00</strong><small>Analysis only</small></div>
          </section>

          <section className="market-feature">
            <div className="market-feature-copy">
              <span className="market-kicker">Featured workflow · RangePilot</span>
              <h2>From task constraints<br />to a signed quote.</h2>
              <p>Adjust two bounded inputs and verify agent identity, request binding, price, terms, and expiry—without connecting a wallet.</p>
              <div><a className="market-primary" href="/demo">Run verified quote <Arrow /></a><a href="/agents/rangepilot">View passport</a></div>
            </div>
            <div className="market-chart" aria-label="Illustrative range analysis grid">
              <div className="chart-label chart-label-a">Current tick</div>
              <div className="chart-label chart-label-b">Target range</div>
              <svg viewBox="0 0 620 240" preserveAspectRatio="none" aria-hidden="true">
                <defs><linearGradient id="market-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#02d7d7" stopOpacity=".28"/><stop offset="1" stopColor="#02d7d7" stopOpacity="0"/></linearGradient></defs>
                <path className="chart-area" d="M0 190 C70 170 105 185 155 130 S245 115 300 145 S390 65 445 95 S530 45 620 62 L620 240 L0 240Z" />
                <path className="chart-line" d="M0 190 C70 170 105 185 155 130 S245 115 300 145 S390 65 445 95 S530 45 620 62" />
                <path className="chart-bound" d="M150 20V220M515 20V220" />
              </svg>
              <div className="chart-axis"><span>−600</span><span>0</span><span>+600</span></div>
            </div>
          </section>

          <section className="agent-directory">
            <div className="directory-head">
              <div><span>Live directory</span><h2>Verified agents</h2></div>
              <div className="category-tabs" role="tablist" aria-label="Agent category">
                {categories.map((item) => <button className={category === item ? "is-active" : ""} key={item} onClick={() => setCategory(item)} type="button">{item}</button>)}
              </div>
            </div>

            <div className="agent-table">
              <div className="agent-table-head"><span>Agent</span><span>Category</span><span>Identity</span><span>Price</span><span>Status</span><span /></div>
              {visibleAgents.map((agent) => (
                <article className="agent-table-row" key={agent.slug}>
                  <div className="table-agent"><img src={agent.art} alt="" /><div><strong>{agent.name}</strong><small>{agent.boundary}</small></div></div>
                  <span>{agent.category}</span>
                  <span className="table-mono">ERC-8004 #{agent.agentId}</span>
                  <strong className="table-price">0.1 <small>U</small></strong>
                  <span className="table-live"><i /> Live</span>
                  <a href={`/agents/${agent.slug}`} aria-label={`Open ${agent.name} passport`}><Arrow /></a>
                </article>
              ))}
              {visibleAgents.length === 0 && <div className="agent-empty">No agents match this filter.</div>}
            </div>
          </section>

          <section className="market-lower">
            <div className="market-activity" id="activity">
              <div className="market-panel-head"><div><span>Retained testnet history</span><h2>Recent jobs</h2></div><a href="/evidence">View evidence <Arrow /></a></div>
              {activity.map((item) => <div className="activity-row" key={item.job}><strong>{item.job}</strong><span>{item.agent}</span><span className="activity-state"><i /> {item.state}</span><span>{item.amount}</span><small>{item.time}</small></div>)}
            </div>
            <aside className="market-boundary-card">
              <span>Execution boundary</span>
              <strong>Your wallet stays out of the demo.</strong>
              <p>The public workflow stops after quote verification. It never funds a job or writes to mainnet.</p>
              <a href="/evidence">Inspect every claim <Arrow /></a>
            </aside>
          </section>
        </div>
      </main>
    </div>
  )
}
