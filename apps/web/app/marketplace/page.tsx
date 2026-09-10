import type { Metadata } from "next"
import MarketplaceDashboard from "../../src/MarketplaceDashboard"

export const metadata: Metadata = {
  title: "Agent Marketplace — KNOT",
  description: "Discover and inspect KNOT's live BNB Chain financial agents.",
}

export default function MarketplacePage() {
  return <MarketplaceDashboard />
}
