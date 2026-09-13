import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildHireCalls } from "@altananetwork/sdk"
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from "viem"
import {
  PostFundingError,
  PostFundingService,
  type BrowserFundingRecord,
  type BrowserFundingStore,
  type ChainJobSnapshot,
  type FundingChainReader,
  type ObservedTransaction,
} from "../../apps/api/src/post-funding.ts"
import { resolveTestnetSdkSource, type CommerceCompatibility } from "../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../packages/db/src/index.ts"
import type { FundingConfirmationInput } from "../../apps/api/src/types.ts"

const buyer = getAddress("0x1111111111111111111111111111111111111111")
const provider = getAddress("0xaf7474d06f171e6fd72fc5af114b34f3d5af8389")
const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
const policy = getAddress("0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA")
const jobId = 42n
const expiredAt = 1_800_004_000n
const budget = 100_000_000_000_000_000n
const description = "signed canonical job description"
const hashes = Array.from({ length: 5 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex)
const eventAbi = parseAbi(["event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)"])

const compatibility: CommerceCompatibility = {
  status: "VERIFIED",
  writeAllowed: true,
  chainId: 97,
  blockNumber: "130000000",
  observedAtUtc: "2027-01-15T08:00:00.000Z",
  sdkVersions: { "@altananetwork/sdk": "0.7.1", "@bnbagent/sdk": "0.5.5" },
  selectedPolicy: policy,
  declarationConflict: true,
  reasons: [],
  policies: [{
    address: policy,
    declaredBy: ["@bnbagent/sdk@0.5.5"],
    codeHash: `0x${"ab".repeat(32)}`,
    whitelisted: true,
    commerce: deployment.commerce,
    router: deployment.router,
    disputeWindowSeconds: "300",
    compatible: true,
  }],
}

const quote = {
  id: "quote_1",
  buyer,
  sellerEndpoint: "https://knot-health.truematchx.com/",
  sellerOwner: provider,
  canonicalJobDescription: description,
  amountUnits: budget.toString(),
  expiresAtUnix: "1800001000",
} as unknown as VerifiedQuoteRecord

const calls = buildHireCalls({
  addresses: {
    commerce: deployment.commerce,
    router: deployment.router,
    policy,
    registry: deployment.registry,
    paymentToken: deployment.paymentToken,
  },
  jobId,
  provider,
  description,
  budget,
  expiredAt,
})

const job = (status: ChainJobSnapshot["status"] = "FUNDED"): ChainJobSnapshot => ({
  id: jobId,
  client: buyer,
  provider,
  evaluator: deployment.router,
  description,
  budget,
  expiredAt,
  status,
  hook: deployment.router,
  submittedAt: status === "SUBMITTED" || status === "COMPLETED" ? 1_800_000_100n : 0n,
  deliverable: status === "SUBMITTED" || status === "COMPLETED" ? `0x${"cd".repeat(32)}` : `0x${"00".repeat(32)}`,
})

const creationLog = {
  address: deployment.commerce,
  topics: encodeEventTopics({ abi: eventAbi, eventName: "JobCreated", args: { jobId, client: buyer, provider } }) as readonly Hex[],
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [deployment.router, expiredAt, deployment.router],
  ),
}

class MemoryFundingStore implements BrowserFundingStore {
  record: BrowserFundingRecord | null = null

  async createClaim(input: FundingConfirmationInput) {
    if (this.record && this.record.creationTransactionHash !== input.creationTransactionHash) {
      throw new PostFundingError("CONFLICT", "different claim")
    }
    this.record ??= {
      verifiedQuoteId: input.verifiedQuote.id,
      buyer,
      creationTransactionHash: input.creationTransactionHash,
      fundingTransactionHashes: input.fundingTransactionHashes,
      verificationState: "PENDING",
      verificationReason: null,
      chainJobId: null,
      confirmedAtBlock: null,
      confirmations: 0,
      jobSnapshot: null,
      sellerNotificationState: "NOT_SENT",
      sellerNotificationAttemptedAt: null,
    }
    return structuredClone(this.record)
  }
  async get(id: string, owner: string) { return this.record?.verifiedQuoteId === id && this.record.buyer === owner ? structuredClone(this.record) : null }
  async markConfirmed(input: { chainJobId: string; confirmedAtBlock: string; confirmations: number; jobSnapshot: ChainJobSnapshot }) {
    Object.assign(this.record!, { verificationState: "CONFIRMED", chainJobId: input.chainJobId, confirmedAtBlock: input.confirmedAtBlock, confirmations: input.confirmations, jobSnapshot: input.jobSnapshot })
    return structuredClone(this.record!)
  }
  async updateSnapshot(_id: string, _owner: string, snapshot: ChainJobSnapshot) { this.record!.jobSnapshot = snapshot; return structuredClone(this.record!) }
  async markNotification(input: { state: "ACKNOWLEDGED" | "RETRYABLE_TIMEOUT" | "REJECTED"; attemptedAt: Date }) {
    this.record!.sellerNotificationState = input.state
    this.record!.sellerNotificationAttemptedAt = input.attemptedAt
    return structuredClone(this.record!)
  }
}

const reader = (options: { pending?: number; mutate?: (values: ObservedTransaction[]) => void; status?: ChainJobSnapshot["status"] } = {}): FundingChainReader => {
  const values = transactions()
  options.mutate?.(values)
  let remainingPending = options.pending ?? 0
  return {
    async transaction(hash) {
      if (remainingPending > 0) { remainingPending -= 1; return null }
      return values.find((item) => item.hash === hash) ?? null
    },
    async job() { return job(options.status) },
  }
}

function transactions(): ObservedTransaction[] {
  return calls.map((call, index) => ({
    hash: hashes[index]!,
    from: buyer,
    to: getAddress(call.to),
    input: call.data!,
    value: call.value ?? 0n,
    status: "success" as const,
    blockNumber: 100n + BigInt(index),
    blockHash: `0x${(index + 10).toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: 0,
    confirmations: 3,
    timestampUnix: 1_800_000_000 + index,
    logs: index === 0 ? [creationLog] : [],
  }))
}

const confirmation: FundingConfirmationInput = {
  verifiedQuote: quote,
  buyer,
  creationTransactionHash: hashes[0]!,
  fundingTransactionHashes: [hashes[1]!, hashes[2]!, hashes[3]!, hashes[4]!],
}

describe("signed browser post-funding verification", () => {
  it("returns a recoverable pending state without notifying when any receipt is uncertain", async () => {
    const store = new MemoryFundingStore()
    let notified = 0
    const service = new PostFundingService(store, reader({ pending: 1 }), async () => compatibility, { async notify() { notified += 1; return {} } }, () => new Date("2027-01-15T08:00:00Z"))
    const result = await service.confirm(confirmation)
    assert.equal(result.status, 202)
    assert.equal(notified, 0)
    assert.equal(store.record?.verificationState, "PENDING")
  })

  it("derives the job id, verifies all five exact calls, and notifies the seller once", async () => {
    const store = new MemoryFundingStore()
    let notified = 0
    const service = new PostFundingService(store, reader(), async () => compatibility, { async notify(input) { notified += 1; assert.equal(input.jobId, "42"); return { accepted: true } } }, () => new Date("2027-01-15T08:00:00Z"))
    const first = await service.confirm(confirmation)
    const replay = await service.confirm(confirmation)
    assert.equal(first.status, 200)
    assert.equal(replay.status, 200)
    assert.equal(notified, 1)
    assert.equal(store.record?.chainJobId, "42")
    assert.equal(store.record?.sellerNotificationState, "ACKNOWLEDGED")
  })

  it("fails closed before notification when one transaction targets altered calldata", async () => {
    const store = new MemoryFundingStore()
    let notified = 0
    const service = new PostFundingService(store, reader({ mutate(values) { values[3]!.input = `0x${"ff".repeat(32)}` } }), async () => compatibility, { async notify() { notified += 1; return {} } }, () => new Date("2027-01-15T08:00:00Z"))
    await assert.rejects(service.confirm(confirmation), (error: unknown) => error instanceof PostFundingError && error.code === "CHAIN_MISMATCH")
    assert.equal(notified, 0)
  })

  it("does not notify a terminal expired job or misstate unproven refund eligibility", async () => {
    const store = new MemoryFundingStore()
    let notified = 0
    const service = new PostFundingService(store, reader({ status: "EXPIRED" }), async () => compatibility, { async notify() { notified += 1; return {} } }, () => new Date("2027-01-15T09:20:00Z"))
    const result = await service.confirm(confirmation)
    const body = result.body as { refund: { available: boolean; action: string }; lifecycle: { financialState: string } }
    assert.equal(notified, 0)
    assert.equal(body.refund.available, false)
    assert.equal(body.refund.action, "BUYER_WALLET_REQUIRED")
    assert.equal(body.lifecycle.financialState, "RESOLUTION_PENDING")
  })
})
