import type { OwnedSellerRequestedTerms } from "./service-quote.ts"

export type OwnedSellerCategory = "health" | "rebalancing" | "grid" | "yield"

export interface OwnedSellerNegotiationRequest {
  skill: "negotiate"
  request: {
    task_description: string
    terms: OwnedSellerRequestedTerms
    request_id: string
  }
}

const termsByCategory: Readonly<Record<OwnedSellerCategory, OwnedSellerRequestedTerms>> = {
  health: {
    deliverables: "One knot.health.artifact/1 JSON assessment tied to the supplied pinned Venus position snapshot.",
    quality_standards: "Deterministic, closed-schema, fail closed on stale or incomplete position data, and analysis only.",
  },
  rebalancing: {
    deliverables: "One knot.rangepilot.artifact/1 JSON assessment tied to the supplied pinned PancakeSwap v3 position snapshot.",
    quality_standards: "Deterministic, closed-schema, fail closed on stale or inconsistent position data, and analysis only.",
  },
  grid: {
    deliverables: "One knot.gridquant.artifact/1 JSON assessment tied to the supplied pinned WBNB/USDT pool snapshot.",
    quality_standards: "Deterministic, closed-schema, fail closed on stale or inconsistent pool data, and analysis only.",
  },
  yield: {
    deliverables: "One knot.yield.artifact/1 JSON assessment tied to the supplied pinned same-asset Venus and Aave market snapshot.",
    quality_standards: "Deterministic, closed-schema, fail closed on stale or incomplete market data, and analysis only.",
  },
}

export const isOwnedSellerCategory = (category: string): category is OwnedSellerCategory =>
  category === "health" || category === "rebalancing" || category === "grid" || category === "yield"

export const ownedSellerTerms = (category: OwnedSellerCategory): OwnedSellerRequestedTerms => ({
  ...termsByCategory[category],
})

export const buildOwnedSellerNegotiationRequest = (input: {
  category: OwnedSellerCategory
  serviceRequestId: string
  taskDescription: string
}): OwnedSellerNegotiationRequest => ({
  skill: "negotiate",
  request: {
    task_description: input.taskDescription,
    terms: ownedSellerTerms(input.category),
    request_id: input.serviceRequestId,
  },
})
