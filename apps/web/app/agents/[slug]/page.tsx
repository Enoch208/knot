import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { agentProfiles, getAgentProfile } from "../../../src/agent-catalog"
import { AgentAffordances, AgentJobHistory } from "../../../src/AgentPassport"

type PageProperties = { params: Promise<{ slug: string }> }

type EndpointState = {
  cardAvailable: boolean
  proofAvailable: boolean
  version: string | null
  protocol: string | null
}

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: PageProperties): Promise<Metadata> {
  const profile = getAgentProfile((await params).slug)
  if (!profile) return { title: "Agent not found — KNOT" }
  return {
    title: `${profile.name} Agent Passport — KNOT`,
    description: profile.fullDescription,
  }
}

export default async function AgentPassportPage({ params }: PageProperties) {
  const profile = getAgentProfile((await params).slug)
  if (!profile) notFound()
  const endpointState = await observeEndpoint(profile.endpoint)
  const nextProfile = agentProfiles[(agentProfiles.findIndex((entry) => entry.slug === profile.slug) + 1) % agentProfiles.length]!

  return (
    <div className={`passport-page passport-${profile.accent}`}>
      <a className="skip-link" href="#passport-main">Skip to passport</a>
      <header className="passport-header">
        <a className="brand" href="/" aria-label="KNOT home">
          <span className="brand-mark"><img src="/images/knot-logo.webp" alt="" /></span>
          <span>KNOT</span>
        </a>
        <nav aria-label="Passport navigation">
          <a href="/#agents">All agents</a>
          <a href="/marketplace">Marketplace</a>
          <a href="/evidence">Evidence</a>
        </nav>
        <span className={`passport-status ${endpointState.cardAvailable ? "is-live" : "is-unknown"}`}>
          <span /> {endpointState.cardAvailable ? "Endpoint available" : "Status unavailable"}
        </span>
      </header>

      <main id="passport-main" className="passport-main">
        <section className="passport-hero">
          <div className="passport-art">
            <span>{profile.index}</span>
            <img src={profile.art} alt={`${profile.name} editorial system illustration`} />
            <p>Identity #{profile.agentId}</p>
          </div>
          <div className="passport-title">
            <p className="eyebrow eyebrow-dark">Agent passport · {profile.category}</p>
            <h1>{profile.name}</h1>
            <p>{profile.fullDescription}</p>
            <div className="passport-actions">
              <a className="button button-dark" href={`${profile.endpoint}/.well-known/agent-card.json`} target="_blank" rel="noreferrer">Inspect live card <Arrow /></a>
              <a className="passport-plain-link" href={`${profile.endpoint}/.well-known/agent-registration.json`} target="_blank" rel="noreferrer">Domain proof ↗</a>
            </div>
          </div>
        </section>

        <section className="passport-facts" aria-label="Agent facts">
          <div><span>Operator</span><strong>KNOT-operated</strong><p>Declared relationship</p></div>
          <div><span>Data network</span><strong>BSC mainnet</strong><p>Read-only observation</p></div>
          <div><span>Commerce</span><strong>BSC testnet</strong><p>Identity and test tokens</p></div>
          <div><span>Capability</span><strong>Analysis only</strong><p>{profile.boundary}</p></div>
        </section>

        <section className="passport-grid">
          <article className="passport-panel passport-capability">
            <div className="panel-heading"><span>01</span><div><p>Capability contract</p><h2>What it does—and refuses.</h2></div></div>
            <div className="capability-columns">
              <div>
                <h3>Supported</h3>
                <ul>{profile.supports.map((item) => <li key={item}><Check /> {item}</li>)}</ul>
              </div>
              <div>
                <h3>Refused</h3>
                <ul>{profile.refuses.map((item) => <li key={item}><span>×</span> {item}</li>)}</ul>
              </div>
            </div>
          </article>

          <article className="passport-panel passport-identity">
            <div className="panel-heading"><span>02</span><div><p>Identity record</p><h2>Who signs the quote.</h2></div></div>
            <dl>
              <div><dt>ERC-8004 agent</dt><dd>{profile.agentId}</dd></div>
              <div><dt>Owner</dt><dd title={profile.owner}>{compact(profile.owner)}</dd></div>
              <div><dt>Registry</dt><dd title={profile.registry}>{compact(profile.registry)}</dd></div>
              <div><dt>A2A protocol</dt><dd>{endpointState.protocol ?? "Unavailable"}</dd></div>
              <div><dt>Agent version</dt><dd>{endpointState.version ?? "Unavailable"}</dd></div>
              <div><dt>Domain proof</dt><dd>{endpointState.proofAvailable ? "Available" : "Unavailable"}</dd></div>
            </dl>
            <p className="identity-note">Live endpoint fields are point-in-time observations—not an uptime guarantee or institutional certification.</p>
          </article>

          <article className="passport-panel passport-example">
            <div className="panel-heading"><span>03</span><div><p>Paid testnet example</p><h2>A result with boundaries.</h2></div></div>
            <div className="example-result-top">
              <span>Job #{profile.paidJobId}</span>
              <strong>{profile.resultLabel}</strong>
            </div>
            <h3>{profile.exampleResult}</h3>
            <p>{profile.exampleDetail}</p>
            <div className="example-evidence">
              <div><span>Payment</span><strong>0.1 testnet U</strong></div>
              <div><span>Outcome</span><strong>Settled</strong></div>
              <div><span>Comparison</span><strong>Honest tie</strong></div>
              <div><span>Evaluation</span><strong>{profile.evidenceDimensions}</strong></div>
            </div>
            <p className="example-disclosure">Historical testnet observation · Team-operated seller and reference · No performance, profit, APY, or mainnet-write claim.</p>
          </article>

          <AgentAffordances profile={profile} />
          <AgentJobHistory profile={profile} />
        </section>

        <section className="passport-next">
          <p>Next specialist</p>
          <a href={`/agents/${nextProfile.slug}`}>
            <span>{nextProfile.category}</span>
            <strong>{nextProfile.name}</strong>
            <Arrow />
          </a>
        </section>
      </main>

      <footer className="demo-page-footer">
        <p>KNOT · Agent Passport</p>
        <p>Mainnet data: read-only · Identity and commerce: BSC testnet</p>
      </footer>
    </div>
  )
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

function compact(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`
}

async function observeEndpoint(endpoint: string): Promise<EndpointState> {
  const [card, proof] = await Promise.allSettled([
    fetch(`${endpoint}/.well-known/agent-card.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    }),
    fetch(`${endpoint}/.well-known/agent-registration.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    }),
  ])
  let version: string | null = null
  let protocol: string | null = null
  const cardAvailable = card.status === "fulfilled" && card.value.ok
  if (cardAvailable && card.status === "fulfilled") {
    try {
      const body = await card.value.json() as Record<string, unknown>
      version = typeof body.version === "string" ? body.version : null
      protocol = typeof body.protocolVersion === "string" ? body.protocolVersion : null
    } catch {
      version = null
      protocol = null
    }
  }
  return {
    cardAvailable,
    proofAvailable: proof.status === "fulfilled" && proof.value.ok,
    version,
    protocol,
  }
}
