import { buildHireCalls } from "@altananetwork/sdk"
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex } from "viem"
import { requireCommerceWriteReady, resolveTestnetSdkSource, type CommerceCompatibility } from "../../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../../packages/db/src/index.ts"
import type { FundingConfirmationInput, PostFundingCoordinator, PostFundingResult } from "./types.ts"

export type FundingVerificationState = "PENDING" | "CONFIRMED" | "REVERTED" | "UNRESOLVED"
export type SellerNotificationState = "NOT_SENT" | "ACKNOWLEDGED" | "RETRYABLE_TIMEOUT" | "REJECTED"
export type ChainJobStatus = "OPEN" | "FUNDED" | "SUBMITTED" | "COMPLETED" | "REJECTED" | "EXPIRED" | "UNKNOWN"

export interface ObservedTransaction {
  hash: Hex
  from: Address
  to: Address | null
  input: Hex
  value: bigint
  status: "success" | "reverted"
  blockNumber: bigint
  blockHash: Hex
  transactionIndex: number
  confirmations: number
  timestampUnix: number
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]
}

export interface ChainJobSnapshot {
  id: bigint
  client: Address
  provider: Address
  evaluator: Address
  description: string
  budget: bigint
  expiredAt: bigint
  status: ChainJobStatus
  hook: Address
  submittedAt: bigint
  deliverable: Hex
}

export interface BrowserFundingRecord {
  verifiedQuoteId: string
  buyer: Address
  creationTransactionHash: Hex
  fundingTransactionHashes: readonly [Hex, Hex, Hex, Hex]
  verificationState: FundingVerificationState
  verificationReason: string | null
  chainJobId: string | null
  confirmedAtBlock: string | null
  confirmations: number
  jobSnapshot: ChainJobSnapshot | null
  sellerNotificationState: SellerNotificationState
  sellerNotificationAttemptedAt: Date | null
}

export interface BrowserFundingStore {
  createClaim(input: FundingConfirmationInput): Promise<BrowserFundingRecord>
  get(verifiedQuoteId: string, buyer: string): Promise<BrowserFundingRecord | null>
  markConfirmed(input: {
    verifiedQuoteId: string
    buyer: string
    chainJobId: string
    confirmedAtBlock: string
    confirmations: number
    jobSnapshot: ChainJobSnapshot
  }): Promise<BrowserFundingRecord>
  updateSnapshot(verifiedQuoteId: string, buyer: string, snapshot: ChainJobSnapshot): Promise<BrowserFundingRecord>
  markNotification(input: {
    verifiedQuoteId: string
    buyer: string
    state: Exclude<SellerNotificationState, "NOT_SENT">
    attemptedAt: Date
    payload: Readonly<Record<string, unknown>>
  }): Promise<BrowserFundingRecord>
}

export interface FundingChainReader {
  transaction(hash: Hex): Promise<ObservedTransaction | null>
  job(jobId: bigint): Promise<ChainJobSnapshot>
}

export interface SellerFundingNotifier {
  notify(input: { endpoint: string; requestId: string; jobId: string }): Promise<Readonly<Record<string, unknown>>>
}

export class PostFundingError extends Error {
  readonly code: "NOT_FOUND" | "CONFLICT" | "CHAIN_MISMATCH" | "CHAIN_REVERTED" | "UPSTREAM_UNAVAILABLE"
  readonly retryable: boolean

  constructor(code: PostFundingError["code"], message: string, retryable = false) {
    super(message)
    this.name = "PostFundingError"
    this.code = code
    this.retryable = retryable
  }
}

const jobCreatedAbi = parseAbi([
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
])
const statuses = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const

const sameAddress = (left: string, right: string): boolean =>
  getAddress(left).toLowerCase() === getAddress(right).toLowerCase()

const sameCall = (observed: ObservedTransaction, expected: { to: string; data?: Hex; value?: bigint }, buyer: string): boolean =>
  observed.to !== null &&
  sameAddress(observed.from, buyer) &&
  sameAddress(observed.to, expected.to) &&
  observed.input.toLowerCase() === expected.data?.toLowerCase() &&
  observed.value === (expected.value ?? 0n)

const ordered = (items: readonly ObservedTransaction[]): boolean =>
  items.every((item, index) => index === 0 || (
    item.blockNumber > items[index - 1]!.blockNumber ||
    item.blockNumber === items[index - 1]!.blockNumber && item.transactionIndex > items[index - 1]!.transactionIndex
  ))

const snapshotJson = (snapshot: ChainJobSnapshot | null) => snapshot === null ? null : {
  id: snapshot.id.toString(),
  client: snapshot.client,
  provider: snapshot.provider,
  evaluator: snapshot.evaluator,
  description: snapshot.description,
  budget: snapshot.budget.toString(),
  expiredAtUnix: Number(snapshot.expiredAt),
  status: snapshot.status,
  hook: snapshot.hook,
  submittedAtUnix: Number(snapshot.submittedAt),
  deliverableHash: snapshot.deliverable,
}

export class PostFundingService implements PostFundingCoordinator {
  private readonly store: BrowserFundingStore
  private readonly reader: FundingChainReader
  private readonly commerceProbe: () => Promise<CommerceCompatibility>
  private readonly notifier: SellerFundingNotifier
  private readonly now: () => Date

  constructor(
    store: BrowserFundingStore,
    reader: FundingChainReader,
    commerceProbe: () => Promise<CommerceCompatibility>,
    notifier: SellerFundingNotifier,
    now: () => Date,
  ) {
    this.store = store
    this.reader = reader
    this.commerceProbe = commerceProbe
    this.notifier = notifier
    this.now = now
  }

  async confirm(input: FundingConfirmationInput): Promise<PostFundingResult> {
    if (!sameAddress(input.buyer, input.verifiedQuote.buyer)) {
      throw new PostFundingError("CONFLICT", "funding claim buyer does not own the verified quote")
    }
    let record = await this.store.createClaim(input)
    if (record.verificationState !== "CONFIRMED") {
      const verified = await this.verify(input.verifiedQuote, record)
      if (verified === null) return this.response(record, 202)
      record = await this.store.markConfirmed({
        verifiedQuoteId: record.verifiedQuoteId,
        buyer: record.buyer,
        chainJobId: verified.job.id.toString(),
        confirmedAtBlock: verified.confirmedAtBlock.toString(),
        confirmations: verified.confirmations,
        jobSnapshot: verified.job,
      })
    }
    record = await this.refresh(input.verifiedQuote, record)
    return this.response(record, 200)
  }

  async status(verifiedQuote: VerifiedQuoteRecord, buyer: string): Promise<PostFundingResult> {
    const record = await this.store.get(verifiedQuote.id, buyer)
    if (!record) throw new PostFundingError("NOT_FOUND", "no signed funding claim exists for this verified quote")
    if (record.verificationState !== "CONFIRMED") {
      const verified = await this.verify(verifiedQuote, record)
      if (verified === null) return this.response(record, 202)
      await this.store.markConfirmed({
        verifiedQuoteId: record.verifiedQuoteId,
        buyer: record.buyer,
        chainJobId: verified.job.id.toString(),
        confirmedAtBlock: verified.confirmedAtBlock.toString(),
        confirmations: verified.confirmations,
        jobSnapshot: verified.job,
      })
    }
    const current = await this.store.get(verifiedQuote.id, buyer)
    if (!current) throw new PostFundingError("NOT_FOUND", "funding claim disappeared")
    return this.response(await this.refresh(verifiedQuote, current), 200)
  }

  private async verify(quote: VerifiedQuoteRecord, record: BrowserFundingRecord): Promise<{
    job: ChainJobSnapshot; confirmedAtBlock: bigint; confirmations: number
  } | null> {
    let observations: (ObservedTransaction | null)[]
    try {
      observations = await Promise.all([
        record.creationTransactionHash,
        ...record.fundingTransactionHashes,
      ].map((hash) => this.reader.transaction(hash)))
    } catch (error) {
      if (error instanceof PostFundingError && !error.retryable) throw error
      return null
    }
    if (observations.some((item) => item === null)) return null
    const transactions = observations as ObservedTransaction[]
    if (transactions.some((item) => item.status === "reverted")) {
      throw new PostFundingError("CHAIN_REVERTED", "a claimed hire transaction reverted")
    }
    if (!ordered(transactions)) throw new PostFundingError("CHAIN_MISMATCH", "hire transactions are not in canonical execution order")
    const creation = transactions[0]!
    if (creation.timestampUnix > Number(quote.expiresAtUnix)) {
      throw new PostFundingError("CHAIN_MISMATCH", "job creation occurred after the signed quote expired")
    }
    const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
    const events = creation.logs.filter((log) => sameAddress(log.address, deployment.commerce)).flatMap((log) => {
      try {
        return [decodeEventLog({
          abi: jobCreatedAbi,
          eventName: "JobCreated",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        }).args]
      } catch {
        return []
      }
    })
    const event = events[0]
    if (!event || events.length !== 1 || event.jobId <= 0n ||
      !sameAddress(event.client, record.buyer) || !sameAddress(event.provider, quote.sellerOwner) ||
      !sameAddress(event.evaluator, deployment.router) || !sameAddress(event.hook, deployment.router)) {
      throw new PostFundingError("CHAIN_MISMATCH", "creation receipt has no unique job bound to the signed buyer and seller")
    }
    const compatibility = await this.commerceProbe()
    const policy = requireCommerceWriteReady(compatibility)
    const calls = buildHireCalls({
      addresses: {
        commerce: deployment.commerce,
        router: deployment.router,
        policy,
        registry: deployment.registry,
        paymentToken: deployment.paymentToken,
      },
      jobId: event.jobId,
      provider: getAddress(quote.sellerOwner),
      description: quote.canonicalJobDescription,
      budget: BigInt(quote.amountUnits),
      expiredAt: event.expiredAt,
    })
    if (calls.length !== transactions.length || transactions.some((transaction, index) => !sameCall(transaction, calls[index]!, record.buyer))) {
      throw new PostFundingError("CHAIN_MISMATCH", "on-chain hire calls do not match the signed quote and pinned commerce boundary")
    }
    const job = await this.reader.job(event.jobId)
    if (job.status === "OPEN" || job.status === "UNKNOWN" || job.id !== event.jobId ||
      !sameAddress(job.client, record.buyer) || !sameAddress(job.provider, quote.sellerOwner) ||
      !sameAddress(job.evaluator, deployment.router) || !sameAddress(job.hook, deployment.router) ||
      job.description !== quote.canonicalJobDescription || job.budget !== BigInt(quote.amountUnits) || job.expiredAt !== event.expiredAt) {
      throw new PostFundingError("CHAIN_MISMATCH", "canonical job state does not match the funded signed quote")
    }
    return {
      job,
      confirmedAtBlock: transactions.reduce((highest, item) => item.blockNumber > highest ? item.blockNumber : highest, 0n),
      confirmations: Math.min(...transactions.map((item) => item.confirmations)),
    }
  }

  private async refresh(quote: VerifiedQuoteRecord, record: BrowserFundingRecord): Promise<BrowserFundingRecord> {
    if (!record.chainJobId) return record
    const chainJobId = record.chainJobId
    let job: ChainJobSnapshot
    try {
      job = await this.reader.job(BigInt(chainJobId))
    } catch {
      return record
    }
    const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
    if (job.id.toString() !== chainJobId || !sameAddress(job.client, record.buyer) ||
      !sameAddress(job.provider, quote.sellerOwner) || !sameAddress(job.evaluator, deployment.router) ||
      !sameAddress(job.hook, deployment.router) || job.description !== quote.canonicalJobDescription ||
      job.budget !== BigInt(quote.amountUnits)) {
      throw new PostFundingError("CHAIN_MISMATCH", "current canonical job state no longer matches the verified hire boundary")
    }
    record = await this.store.updateSnapshot(record.verifiedQuoteId, record.buyer, job)
    if (record.sellerNotificationState === "ACKNOWLEDGED" || record.sellerNotificationState === "REJECTED") return record
    if (job.status === "SUBMITTED" || job.status === "COMPLETED") {
      return this.store.markNotification({
        verifiedQuoteId: record.verifiedQuoteId,
        buyer: record.buyer,
        state: "ACKNOWLEDGED",
        attemptedAt: this.now(),
        payload: { inferredFromCanonicalJobStatus: job.status },
      })
    }
    if (job.status !== "FUNDED") return record
    try {
      const payload = await this.notifier.notify({
        endpoint: quote.sellerEndpoint,
        requestId: record.verifiedQuoteId,
        jobId: chainJobId,
      })
      return this.store.markNotification({
        verifiedQuoteId: record.verifiedQuoteId,
        buyer: record.buyer,
        state: "ACKNOWLEDGED",
        attemptedAt: this.now(),
        payload,
      })
    } catch (error) {
      const retryable = !(error instanceof PostFundingError) || error.retryable
      return this.store.markNotification({
        verifiedQuoteId: record.verifiedQuoteId,
        buyer: record.buyer,
        state: retryable ? "RETRYABLE_TIMEOUT" : "REJECTED",
        attemptedAt: this.now(),
        payload: { reason: "seller notification did not complete" },
      })
    }
  }

  private response(record: BrowserFundingRecord, status: 200 | 202): PostFundingResult {
    const job = record.jobSnapshot
    const nowUnix = Math.floor(this.now().getTime() / 1000)
    const refundPotentiallyEligible = job?.status === "EXPIRED" && nowUnix >= Number(job.expiredAt)
    const workState = job === null ? "PAYMENT_OBSERVED" :
      job.status === "FUNDED" ? "RUNNING" :
      job.status === "SUBMITTED" ? "OUTPUT_RECEIVED" :
      job.status === "COMPLETED" ? "OUTPUT_CHECKED" :
      job.status === "REJECTED" || job.status === "EXPIRED" ? "FAILED" : "PAYMENT_OBSERVED"
    const financialState = job === null ? "UNKNOWN" :
      job.status === "COMPLETED" ? "PAID" :
      job.status === "REJECTED" || job.status === "EXPIRED" ? "RESOLUTION_PENDING" : "ESCROWED"
    return { status, body: {
      verifiedQuoteId: record.verifiedQuoteId,
      buyer: record.buyer,
      jobId: record.chainJobId,
      verification: { state: record.verificationState, reason: record.verificationReason },
      chain: {
        chainId: 97,
        commerce: resolveTestnetSdkSource("@bnbagent/sdk").deployment.commerce,
        creationTransactionHash: record.creationTransactionHash,
        fundingTransactionHashes: record.fundingTransactionHashes,
        confirmedAtBlock: record.confirmedAtBlock,
        confirmations: record.confirmations,
      },
      job: job === null ? null : snapshotJson(job),
      lifecycle: { workState, financialState },
      sellerNotification: {
        state: record.sellerNotificationState,
        attemptedAtUtc: record.sellerNotificationAttemptedAt?.toISOString() ?? null,
        retryable: record.sellerNotificationState === "RETRYABLE_TIMEOUT",
      },
      deliverable: { available: job?.status === "SUBMITTED" || job?.status === "COMPLETED", url: null },
      refund: {
        available: false,
        availableAtUnix: job ? Number(job.expiredAt) : null,
        reason: refundPotentiallyEligible
          ? "Job expired; refund eligibility has not yet been proven from chain state."
          : "Refund is not currently proven available.",
        action: "BUYER_WALLET_REQUIRED",
        call: null,
      },
    } }
  }
}

export function chainJobStatus(value: number): ChainJobStatus {
  return statuses[value] ?? "UNKNOWN"
}
