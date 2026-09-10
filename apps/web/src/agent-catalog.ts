export type AgentSlug = "healthguard" | "rangepilot" | "gridquant" | "yieldscout"

export type AgentProfile = {
  slug: AgentSlug
  index: string
  name: string
  category: string
  shortDescription: string
  fullDescription: string
  boundary: string
  refuses: string[]
  supports: string[]
  art: string
  accent: "mint" | "cyan" | "amber" | "violet"
  agentId: string
  owner: string
  endpoint: string
  registry: string
  quoteRoute: string | null
  quoteBlockedReason: string | null
  paidJobId: string
  exampleResult: string
  exampleDetail: string
  resultLabel: string
  evidenceDimensions: string
}

const registry = "0x8004A818BFB912233c491871b3d84c89A494BD9e"

export const agentProfiles: readonly AgentProfile[] = [
  {
    slug: "healthguard",
    index: "01",
    name: "HealthGuard",
    category: "Lending health",
    shortDescription: "Reads a supported Venus position and makes incomplete data visible.",
    fullDescription:
      "HealthGuard evaluates a pinned Venus Core lending snapshot, reports the observed collateral and debt boundary, and recommends a bounded next step only when the evidence is complete.",
    boundary: "Analysis and notifications only",
    refuses: ["No repayment transaction", "No liquidation guarantee", "No safe status from missing data"],
    supports: ["Pinned Venus Core snapshots", "Health and debt classification", "Explicit incomplete-data states"],
    art: "/images/agent-healthguard.webp",
    accent: "mint",
    agentId: "2295",
    owner: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
    endpoint: "https://knot-health.truematchx.com",
    registry,
    quoteRoute: null,
    quoteBlockedReason:
      "No public quote route is deployed for this agent; its signed quote is a retained authenticated observation.",
    paidJobId: "1185",
    exampleResult: "No debt observed",
    exampleDetail: "The paid example saw no debt at the pinned block and returned no repayment recommendation.",
    resultLabel: "NO_DEBT · NONE",
    evidenceDimensions: "4 of 4 quality dimensions tied",
  },
  {
    slug: "rangepilot",
    index: "02",
    name: "RangePilot",
    category: "LP range analysis",
    shortDescription: "Assesses a PancakeSwap V3 position against its pool and constraints.",
    fullDescription:
      "RangePilot checks a pinned PancakeSwap V3 position, token ordering, ticks, pool state, ownership, budget and gas evidence before returning a hold, refusal, or bounded range proposal.",
    boundary: "No position transactions",
    refuses: ["No liquidity transaction", "No future-yield claim", "No proposal from stale evidence"],
    supports: ["Pinned PancakeSwap V3 positions", "Tick-aligned range checks", "Budget and gas constraints"],
    art: "/images/agent-rangepilot.webp",
    accent: "cyan",
    agentId: "2297",
    owner: "0xE4feD886b4b9062486d4663c6962E14473Bd7320",
    endpoint: "https://knot-range.truematchx.com",
    registry,
    quoteRoute: "/demo",
    quoteBlockedReason: null,
    paidJobId: "1189",
    exampleResult: "Position in range",
    exampleDetail: "The paid example classified the position as in range and returned HOLD without inventing fee history.",
    resultLabel: "IN_RANGE · HOLD",
    evidenceDimensions: "6 of 6 quality dimensions tied",
  },
  {
    slug: "gridquant",
    index: "03",
    name: "GridQuant",
    category: "Grid design",
    shortDescription: "Turns a pinned WBNB/USDT market snapshot into a bounded grid plan.",
    fullDescription:
      "GridQuant derives a price ladder only after checking the allowlisted pair, decimals, capital conservation, inventory exposure, fees, slippage, expiry, and cooldown conditions.",
    boundary: "No orders, fills, or profit claims",
    refuses: ["No swap or order submission", "No fabricated fill history", "No plan outside capital limits"],
    supports: ["Pinned WBNB/USDT pool data", "Arithmetic grid construction", "Capital and fee checks"],
    art: "/images/agent-gridquant.webp",
    accent: "amber",
    agentId: "2298",
    owner: "0x3D5355A97352f4D078016342AD117a5E88D5C74f",
    endpoint: "https://knot-grid.truematchx.com",
    registry,
    quoteRoute: null,
    quoteBlockedReason:
      "The seller endpoint is live, but no public verified-quote route is deployed for this agent yet.",
    paidJobId: "1187",
    exampleResult: "Five-level plan",
    exampleDetail: "The paid example produced a capital-bounded five-level arithmetic plan; completed trade count remained zero.",
    resultLabel: "PLAN · ANALYSIS",
    evidenceDimensions: "5 of 5 quality dimensions tied",
  },
  {
    slug: "yieldscout",
    index: "04",
    name: "YieldScout",
    category: "Yield comparison",
    shortDescription: "Compares supported Venus and Aave same-asset supply markets.",
    fullDescription:
      "YieldScout compares pinned same-asset supply markets after rate normalization, incentives, entry and exit costs, liquidity, protocol eligibility, and the user’s holding horizon.",
    boundary: "No deposits, withdrawals, or migrations",
    refuses: ["No asset migration", "No APY or return promise", "No recommendation with unknown costs"],
    supports: ["Venus and Aave V3 USDT markets", "Cost-aware horizon comparison", "Liquidity and risk exclusions"],
    art: "/images/agent-yieldscout.webp",
    accent: "violet",
    agentId: "2299",
    owner: "0x6fD04720c7FcCB6dCEBf6cF08dD6f5C764c7D8E3",
    endpoint: "https://knot-yield.truematchx.com",
    registry,
    quoteRoute: null,
    quoteBlockedReason:
      "The seller endpoint is live, but no public verified-quote route is deployed for this agent yet.",
    paidJobId: "1188",
    exampleResult: "Eligible market selected",
    exampleDetail: "The paid example selected Aave V3 USDT under fixed-rate assumptions; KNOT performed no migration.",
    resultLabel: "ASSESSED · MIGRATE",
    evidenceDimensions: "5 of 5 quality dimensions tied",
  },
] as const

export function getAgentProfile(slug: string) {
  return agentProfiles.find((profile) => profile.slug === slug)
}

