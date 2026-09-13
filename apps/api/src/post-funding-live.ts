import type { Pool } from "pg"
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { bscTestnet } from "viem/chains"
import { resolveOwnedSellerAuthority } from "../../../packages/discovery/src/public-sellers.ts"
import { OwnedSellerClient, OwnedSellerClientError } from "../../../packages/security/src/owned-seller-client.ts"
import type { OwnedSellerConfig } from "./owned-seller-config.ts"
import {
  PostFundingError,
  chainJobStatus,
  type BrowserFundingRecord,
  type BrowserFundingStore,
  type ChainJobSnapshot,
  type FundingChainReader,
  type SellerFundingNotifier,
} from "./post-funding.ts"
import type { FundingConfirmationInput } from "./types.ts"

const commerceAbi = parseAbi([
  "function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook,uint256 submittedAt,bytes32 deliverable))",
])

const normalizeSnapshot = (value: ChainJobSnapshot): Record<string, unknown> => ({
  ...value,
  id: value.id.toString(),
  budget: value.budget.toString(),
  expiredAt: value.expiredAt.toString(),
  submittedAt: value.submittedAt.toString(),
})

const parseSnapshot = (value: unknown): ChainJobSnapshot | null => {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  try {
    return {
      id: BigInt(String(row.id)),
      client: getAddress(String(row.client)),
      provider: getAddress(String(row.provider)),
      evaluator: getAddress(String(row.evaluator)),
      description: String(row.description),
      budget: BigInt(String(row.budget)),
      expiredAt: BigInt(String(row.expiredAt)),
      status: chainJobStatus(Number(row.status === "UNKNOWN" ? -1 : ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].indexOf(String(row.status)))),
      hook: getAddress(String(row.hook)),
      submittedAt: BigInt(String(row.submittedAt)),
      deliverable: String(row.deliverable) as Hex,
    }
  } catch {
    throw new Error("stored browser funding snapshot is invalid")
  }
}

interface FundingRow {
  verified_quote_id: string
  buyer: Address
  creation_transaction_hash: Hex
  funding_transaction_hashes: Hex[]
  verification_state: BrowserFundingRecord["verificationState"]
  verification_reason: string | null
  chain_job_id: string | null
  confirmed_at_block: string | null
  confirmations: number
  job_snapshot: unknown
  seller_notification_state: BrowserFundingRecord["sellerNotificationState"]
  seller_notification_attempted_at: Date | null
}

const mapRecord = (row: FundingRow): BrowserFundingRecord => ({
  verifiedQuoteId: row.verified_quote_id,
  buyer: getAddress(row.buyer),
  creationTransactionHash: row.creation_transaction_hash,
  fundingTransactionHashes: row.funding_transaction_hashes as [Hex, Hex, Hex, Hex],
  verificationState: row.verification_state,
  verificationReason: row.verification_reason,
  chainJobId: row.chain_job_id,
  confirmedAtBlock: row.confirmed_at_block,
  confirmations: row.confirmations,
  jobSnapshot: parseSnapshot(row.job_snapshot),
  sellerNotificationState: row.seller_notification_state,
  sellerNotificationAttemptedAt: row.seller_notification_attempted_at,
})

export class PgBrowserFundingStore implements BrowserFundingStore {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }

  async createClaim(input: FundingConfirmationInput): Promise<BrowserFundingRecord> {
    try {
      await this.pool.query(
        "INSERT INTO browser_funding_claims (verified_quote_id, buyer, creation_transaction_hash, funding_transaction_hashes, verification_state) VALUES ($1, lower($2), lower($3), $4::jsonb, 'PENDING') ON CONFLICT (verified_quote_id) DO NOTHING",
        [input.verifiedQuote.id, input.buyer, input.creationTransactionHash, JSON.stringify(input.fundingTransactionHashes.map((hash) => hash.toLowerCase()))],
      )
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new PostFundingError("CONFLICT", "transaction evidence is already bound to another verified quote")
      }
      throw error
    }
    const record = await this.get(input.verifiedQuote.id, input.buyer)
    if (!record || record.creationTransactionHash.toLowerCase() !== input.creationTransactionHash.toLowerCase() ||
      record.fundingTransactionHashes.some((hash, index) => hash.toLowerCase() !== input.fundingTransactionHashes[index]?.toLowerCase())) {
      throw new PostFundingError("CONFLICT", "verified quote is already bound to a different funding claim")
    }
    return record
  }

  async get(verifiedQuoteId: string, buyer: string): Promise<BrowserFundingRecord | null> {
    const result = await this.pool.query<FundingRow>("SELECT * FROM browser_funding_claims WHERE verified_quote_id = $1 AND buyer = lower($2)", [verifiedQuoteId, buyer])
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  }

  async markConfirmed(input: { verifiedQuoteId: string; buyer: string; chainJobId: string; confirmedAtBlock: string; confirmations: number; jobSnapshot: ChainJobSnapshot }): Promise<BrowserFundingRecord> {
    await this.pool.query(
      "UPDATE browser_funding_claims SET verification_state = 'CONFIRMED', verification_reason = NULL, chain_job_id = $3, confirmed_at_block = $4, confirmations = $5, job_snapshot = $6::jsonb WHERE verified_quote_id = $1 AND buyer = lower($2) AND (chain_job_id IS NULL OR chain_job_id = $3)",
      [input.verifiedQuoteId, input.buyer, input.chainJobId, input.confirmedAtBlock, input.confirmations, JSON.stringify(normalizeSnapshot(input.jobSnapshot))],
    )
    return this.required(input.verifiedQuoteId, input.buyer)
  }

  async updateSnapshot(verifiedQuoteId: string, buyer: string, snapshot: ChainJobSnapshot): Promise<BrowserFundingRecord> {
    await this.pool.query("UPDATE browser_funding_claims SET job_snapshot = $3::jsonb WHERE verified_quote_id = $1 AND buyer = lower($2) AND verification_state = 'CONFIRMED'", [verifiedQuoteId, buyer, JSON.stringify(normalizeSnapshot(snapshot))])
    return this.required(verifiedQuoteId, buyer)
  }

  async markNotification(input: { verifiedQuoteId: string; buyer: string; state: "ACKNOWLEDGED" | "RETRYABLE_TIMEOUT" | "REJECTED"; attemptedAt: Date; payload: Readonly<Record<string, unknown>> }): Promise<BrowserFundingRecord> {
    await this.pool.query(
      "UPDATE browser_funding_claims SET seller_notification_state = $3, seller_notification_attempted_at = $4, seller_notification_payload = $5::jsonb WHERE verified_quote_id = $1 AND buyer = lower($2) AND seller_notification_state NOT IN ('ACKNOWLEDGED', 'REJECTED')",
      [input.verifiedQuoteId, input.buyer, input.state, input.attemptedAt, JSON.stringify(input.payload)],
    )
    return this.required(input.verifiedQuoteId, input.buyer)
  }

  private async required(verifiedQuoteId: string, buyer: string): Promise<BrowserFundingRecord> {
    const record = await this.get(verifiedQuoteId, buyer)
    if (!record) throw new PostFundingError("NOT_FOUND", "browser funding claim was not found")
    return record
  }
}

export function createLiveFundingChainReader(rpcUrl: string): FundingChainReader {
  const client = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) })
  return new ViemFundingChainReader(client)
}

class ViemFundingChainReader implements FundingChainReader {
  private readonly client: PublicClient
  constructor(client: PublicClient) { this.client = client }

  async transaction(hash: Hex) {
    try {
      if (await this.client.getChainId() !== 97) throw new PostFundingError("CHAIN_MISMATCH", "funding reader is not on BSC testnet")
      const receipt = await this.client.getTransactionReceipt({ hash })
      const head = await this.client.getBlockNumber({ cacheTime: 0 })
      const confirmations = Number(head - receipt.blockNumber + 1n)
      if (confirmations < 2) return null
      const [block, transaction] = await Promise.all([
        this.client.getBlock({ blockNumber: receipt.blockNumber }),
        this.client.getTransaction({ hash }),
      ])
      if (!block.hash || block.hash !== receipt.blockHash || transaction.blockHash !== receipt.blockHash ||
        transaction.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        transaction.chainId !== 97) {
        throw new PostFundingError("CHAIN_MISMATCH", "transaction, receipt, and canonical block disagree")
      }
      return {
        hash,
        from: getAddress(transaction.from),
        to: transaction.to ? getAddress(transaction.to) : null,
        input: transaction.input,
        value: transaction.value,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        confirmations,
        timestampUnix: Number(block.timestamp),
        logs: receipt.logs.map((log) => ({ address: getAddress(log.address), data: log.data, topics: log.topics })),
      } as const
    } catch (error) {
      if (error instanceof PostFundingError) throw error
      const name = error instanceof Error ? error.name : ""
      if (name.includes("NotFound")) return null
      throw new PostFundingError("UPSTREAM_UNAVAILABLE", "BSC testnet receipt observation is unavailable", true)
    }
  }

  async job(jobId: bigint): Promise<ChainJobSnapshot> {
    const deployment = (await import("../../../packages/commerce/src/deployments.ts")).resolveTestnetSdkSource("@bnbagent/sdk").deployment
    const value = await this.client.readContract({ address: deployment.commerce, abi: commerceAbi, functionName: "getJob", args: [jobId] })
    return {
      id: value.id,
      client: value.client,
      provider: value.provider,
      evaluator: value.evaluator,
      description: value.description,
      budget: value.budget,
      expiredAt: value.expiredAt,
      status: chainJobStatus(value.status),
      hook: value.hook,
      submittedAt: value.submittedAt,
      deliverable: value.deliverable,
    }
  }
}

export function createOwnedSellerFundingNotifier(config: OwnedSellerConfig): SellerFundingNotifier {
  return {
    async notify(input) {
      if (!config.enabled) throw new PostFundingError("UPSTREAM_UNAVAILABLE", "owned seller notifications are disabled", true)
      const seller = resolveOwnedSellerAuthority("health", input.endpoint) ??
        resolveOwnedSellerAuthority("rebalancing", input.endpoint) ??
        resolveOwnedSellerAuthority("grid", input.endpoint) ??
        resolveOwnedSellerAuthority("yield", input.endpoint)
      if (!seller) throw new PostFundingError("CONFLICT", "verified quote endpoint is not an owned seller")
      const client = new OwnedSellerClient({
        key: seller.key,
        origin: seller.origin,
        tokenUrl: `${seller.origin}/oauth/token`,
        invocationUrl: `${seller.origin}/`,
        oauthScope: seller.oauthScope,
      }, config.credentials[seller.key])
      try {
        const result = await client.negotiate({ requestId: input.requestId, data: { skill: "notify_funded", job_id: input.jobId } })
        if (result.payload.status !== "accepted" || String(result.payload.job_id) !== input.jobId) {
          throw new PostFundingError("CONFLICT", "owned seller rejected or misbound the funding notification")
        }
        return result.payload
      } catch (error) {
        if (error instanceof OwnedSellerClientError) {
          throw new PostFundingError(error.retryable ? "UPSTREAM_UNAVAILABLE" : "CONFLICT", "owned seller notification failed", error.retryable)
        }
        throw error
      }
    },
  }
}
