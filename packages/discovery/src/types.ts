import { z } from "zod"
import { address, chainId } from "../../contracts/src/primitives.ts"

export const scanAgentItem = z
  .object({
    agent_id: z.string().min(1),
    token_id: z.string().min(1),
    chain_id: z.number().int(),
    contract_address: address,
    is_testnet: z.boolean(),
    owner_address: address,
    name: z.string().nullable(),
    description: z.string().nullable(),
    is_verified: z.boolean(),
    supported_protocols: z.array(z.string()).nullable(),
    x402_supported: z.boolean().nullable(),
    total_feedbacks: z.number().int().nonnegative().nullable(),
    average_score: z.number().nullable(),
    health_score: z.number().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .loose()

export type ScanAgentItem = z.infer<typeof scanAgentItem>

export const scanAgentPage = z
  .object({
    items: z.array(scanAgentItem),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().optional(),
  })
  .loose()

export type ScanAgentPage = z.infer<typeof scanAgentPage>

export const supportedRegistryChain = chainId

export interface DiscoveryQuery {
  chainId?: 56 | 97
  search?: string
  limit?: number
  cursor?: string
}

export interface DiscoveryCoverage {
  source: string
  requestUri: string
  observedAtUtc: string
  returnedCount: number
  matchingTotal: number
  hasMore: boolean
  nextCursor: string | null
  filter: DiscoveryQuery
}

export interface RateLimitSnapshot {
  remainingMinute: number | null
  remainingDay: number | null
}
