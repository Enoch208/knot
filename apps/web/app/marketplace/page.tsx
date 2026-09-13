import type { Metadata } from "next"
import MarketplaceDashboard from "../../src/MarketplaceDashboard"
import { agentProfiles } from "../../src/agent-catalog"
import { readClaimLedger } from "../../src/claim-ledger"
import { discoveryCoverage } from "../../src/discovery-coverage"
import { observeAgentEndpoints } from "../../src/live-agent-observations"

export const metadata: Metadata = {
  title: "Agent Marketplace — KNOT",
  description: "Discover and inspect KNOT's live BNB Chain financial agents.",
}

export const dynamic = "force-dynamic"

export default async function MarketplacePage() {
  const [ledger, endpointObservations] = await Promise.all([
    readClaimLedger(),
    observeAgentEndpoints(agentProfiles),
  ])
  return (
    <MarketplaceDashboard
      ledger={ledger}
      coverage={discoveryCoverage}
      endpointObservations={endpointObservations}
    />
  )
}
