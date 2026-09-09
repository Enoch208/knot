import { readFileSync } from "node:fs"
import { verifyThirdPartyAudition } from "../packages/discovery/src/index.ts"

const evidencePath = process.argv[2] ?? "evidence/testnet/third-party-health-audition-expanded.json"
const input: unknown = JSON.parse(readFileSync(evidencePath, "utf8"))
const report = verifyThirdPartyAudition(input)
process.stdout.write(`${JSON.stringify({
  status: report.summary.hireableCount > 0 ? "HIREABLE_CANDIDATE_VERIFIED" : "NO_HIREABLE_CANDIDATE_VERIFIED",
  observedAtUtc: report.observedAtUtc,
  scope: report.scope,
  safety: report.safety,
  candidates: report.candidates.map((candidate) => ({
    identity: `${candidate.identity.chainId}:${candidate.identity.agentId}`,
    registered: candidate.stages.registered.outcome,
    endpointLive: candidate.stages.endpointLive.outcome,
    callable: candidate.stages.callable.outcome,
    quoteCapable: candidate.stages.quoteCapable.outcome,
    hireable: candidate.stages.hireable.outcome,
  })),
  summary: report.summary,
}, null, 2)}\n`)
