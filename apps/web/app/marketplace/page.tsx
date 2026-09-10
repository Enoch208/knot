import type { Metadata } from "next"
import MarketplaceDashboard from "../../src/MarketplaceDashboard"
import { readClaimLedger } from "../../src/claim-ledger"
import { discoveryCoverage } from "../../src/discovery-coverage"

export const metadata: Metadata = {
  title: "Agent Marketplace — KNOT",
  description: "Discover and inspect KNOT's live BNB Chain financial agents.",
}

export default async function MarketplacePage() {
  const ledger = await readClaimLedger()
  return <MarketplaceDashboard ledger={ledger} coverage={discoveryCoverage} />
}
