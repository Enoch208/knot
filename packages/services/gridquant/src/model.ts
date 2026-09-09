import { gridQuantResult, type GridQuantRequest, type GridQuantResult } from "./schemas.ts"

export const GRIDQUANT_PAIR = {
  chainId: 56,
  baseToken: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  baseDecimals: 18,
  quoteToken: "0x55d398326f99059ff775485246999027b3197955",
  quoteDecimals: 18,
  pool: "0x172fcd41e0913e95784454622d1c3724f546f849",
  poolFeeBpsPerSwap: 1,
} as const

export const result = (value: GridQuantResult): GridQuantResult => gridQuantResult.parse(value)

export const rejected = (
  reason: Extract<GridQuantResult, { outcome: "REJECTED" }>["reason"],
  explanation: string,
  details: string[] = [],
): GridQuantResult => result({ schemaVersion: "knot.gridquant.result/1", outcome: "REJECTED", capability: "analysis", reason, explanation, details })

export const unsupported = (
  reason: Extract<GridQuantResult, { outcome: "UNSUPPORTED" }>["reason"],
  explanation: string,
): GridQuantResult => result({ schemaVersion: "knot.gridquant.result/1", outcome: "UNSUPPORTED", capability: "analysis", reason, explanation })

export const isAllowlistedPair = (request: GridQuantRequest): boolean =>
  request.pair.chainId === GRIDQUANT_PAIR.chainId &&
  request.pair.baseToken.address.toLowerCase() === GRIDQUANT_PAIR.baseToken &&
  request.pair.quoteToken.address.toLowerCase() === GRIDQUANT_PAIR.quoteToken &&
  request.pair.pool.toLowerCase() === GRIDQUANT_PAIR.pool

export const performance = {
  realizedPnlQuoteUnits: null,
  openInventoryMarkToMarketQuoteUnits: null,
  completedTradeCount: 0,
  basis: "NO_OBSERVED_FILLS",
} as const

export const fillPolicy = {
  executionModel: "OFFCHAIN_CONDITIONAL_SWAP_ANALYSIS",
  ambiguousFill: "NO_FILL",
  sameSideRetrigger: "REFUSED",
  requiresObservedReceiptForFill: true,
} as const

export const timingFor = (request: GridQuantRequest) => ({
  evaluatedAtUtc: request.evaluatedAtUtc,
  expiryUtc: request.expiryUtc,
  cooldownSeconds: request.cooldownSeconds,
  lastActionUtc: request.lastActionUtc,
})
