import "./styles/passport.css"
import type { AgentProfile, AgentSlug } from "./agent-catalog"

type AgentJobRecord = {
  jobId: string
  workState: string
  moneyState: string
  settled: boolean
  transactionHash: string
  artifactUrl: string
}

type Affordance = {
  name: string
  href: string | null
  action: string
  note: string
}

const hireBlockedReason =
  "No public funding route: this build stops at the verified quote and creates no job."

const explorer = "https://testnet.bscscan.com/tx/"
const artifacts = "https://knot-artifacts.truematchx.com/knot-deliverables/"
const bnbagentArtifacts = "https://bnbagent-api.bnbchain.world/v1/deliverables/sha256/"

const agentJobRecords: Record<AgentSlug, readonly AgentJobRecord[]> = {
  healthguard: [
    {
      jobId: "1180",
      workState: "INVALID_REQUEST · expired without an assessment",
      moneyState: "Refunded",
      settled: false,
      transactionHash: "0xa700168057f303090aa44e758e05857b41a2175e3a3643ab1cd366e34cd11469",
      artifactUrl: `${bnbagentArtifacts}067712d7a1b5102c7cf3553d5cb34e9f1ffb260172ff2dfafc166c88dd2639d7.json`,
    },
    {
      jobId: "1181",
      workState: "NO_DEBT · verified delivery",
      moneyState: "Settled",
      settled: true,
      transactionHash: "0xa3c67eafa69c2b2b2307989efd0df8cbd79fe036f763bdd87b6c4a1816c4483a",
      artifactUrl: `${bnbagentArtifacts}476813b986a82578811db331e53c071bba95a5163ce67e1aa0cde447c72cfa80.json`,
    },
    {
      jobId: "1185",
      workState: "NO_DEBT · verified delivery",
      moneyState: "Settled",
      settled: true,
      transactionHash: "0xe0e7ffbdd4cddad0f852d3710dde30d734416f30480378edfe227f41823e92ca",
      artifactUrl: `${artifacts}healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json`,
    },
  ],
  rangepilot: [
    {
      jobId: "1189",
      workState: "IN_RANGE_HOLD · verified delivery",
      moneyState: "Settled",
      settled: true,
      transactionHash: "0xcf39c2df74fb81682e2144858e4ea8fcf6de7fdf00b6bcdbbff625430eefcc01",
      artifactUrl: `${artifacts}rangepilot/sha256/ca13ae8a177a33a5180762ceaca2faa8bf8415d14079e52980fb5bec3130432a.json`,
    },
  ],
  gridquant: [
    {
      jobId: "1187",
      workState: "PLAN · verified delivery",
      moneyState: "Settled",
      settled: true,
      transactionHash: "0x2431cdd26ae5607ae461846a21084819abb3cb0002a83e5207b493fa8efc36cc",
      artifactUrl: `${artifacts}gridquant/sha256/0a8f485757cdc3308e95e944362e2be73d966b2a7309da437abc8f9e04adf152.json`,
    },
  ],
  yieldscout: [
    {
      jobId: "1188",
      workState: "MIGRATE · verified delivery",
      moneyState: "Settled",
      settled: true,
      transactionHash: "0x388afeef6359d213c0259f38601915e1e2678d304ff733281a5d3aae052861af",
      artifactUrl: `${artifacts}yieldscout/sha256/c3fbb46a4df2110bf3d3f9dfa5c101d5488c0b0c6cd0c4afbc62103cc550edd9.json`,
    },
  ],
}

function readAffordances(profile: AgentProfile): readonly Affordance[] {
  const jobs = agentJobRecords[profile.slug]
  return [
    {
      name: "Evidence",
      href: "/evidence#comparisons",
      action: "Open evidence record",
      note: `Retained paired experiment ${profile.slug}-${profile.paidJobId}, recomputed from raw evidence.`,
    },
    {
      name: "History",
      href: "#job-history",
      action: "Read job history",
      note: `${jobs.length} recorded BSC testnet ${jobs.length === 1 ? "job" : "jobs"}, work state and money state kept apart.`,
    },
    {
      name: "Request quote",
      href: profile.quoteRoute,
      action: "Run verified quote",
      note: profile.quoteBlockedReason ?? "A live signed quote, verified against ERC-8004 identity and stopped before funding.",
    },
    { name: "Hire", href: null, action: "Fund this agent", note: hireBlockedReason },
  ]
}

export function AgentAffordances({ profile }: { profile: AgentProfile }) {
  return (
    <article className="passport-panel passport-affordances" id="affordances">
      <div className="panel-heading">
        <span>04</span>
        <div><p>Marketplace affordances</p><h2>The same four moves.</h2></div>
      </div>
      <ul className="affordance-grid">
        {readAffordances(profile).map((affordance) => (
          <li className={`affordance-tile ${affordance.href ? "is-live" : "is-blocked"}`} key={affordance.name}>
            <h3>{affordance.name}</h3>
            <span className="affordance-state">{affordance.href ? "Available" : "Unavailable"}</span>
            <p className={affordance.href ? "affordance-copy" : "affordance-copy is-reason"}>{affordance.note}</p>
            {affordance.href ? (
              <a className="affordance-action" href={affordance.href}>{affordance.action} <Arrow /></a>
            ) : (
              <span className="affordance-action" aria-disabled="true">Not available</span>
            )}
          </li>
        ))}
      </ul>
      <p className="affordance-note">
        Every passport carries these four affordances in the same order. An unavailable state means the
        path is not deployed for this agent—not that it is hidden.
      </p>
    </article>
  )
}

export function AgentJobHistory({ profile }: { profile: AgentProfile }) {
  const jobs = agentJobRecords[profile.slug]
  return (
    <article className="passport-panel passport-history" id="job-history">
      <div className="panel-heading">
        <span>05</span>
        <div><p>Recorded jobs · BSC testnet</p><h2>Work state, then money state.</h2></div>
      </div>
      <div className="history-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Job</th><th scope="col">Work state</th>
              <th scope="col">Money state</th><th scope="col">Amount</th><th scope="col">Records</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td className="history-job">#{job.jobId}</td>
                <td>{job.workState}</td>
                <td>
                  <i className={job.settled ? "history-dot is-settled" : "history-dot is-refunded"} />
                  {job.moneyState}
                </td>
                <td className="history-amount">0.1 U</td>
                <td className="history-links">
                  <a href={`${explorer}${job.transactionHash}`} target="_blank" rel="noreferrer">Transaction ↗</a>
                  <a href={job.artifactUrl} target="_blank" rel="noreferrer">Artifact ↗</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="history-note">
        Testnet U and tBNB are not revenue or dollars. {jobs.length === 1 ? "One recorded job does" : "These recorded jobs do"} not
        establish repeatability, uptime, earnings, or superiority.
      </p>
    </article>
  )
}

const Arrow = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
    <path d="M5 15 15 5M7 5h8v8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
  </svg>
)
