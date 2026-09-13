import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import { createApiHandler } from "../../apps/api/src/app.ts"
import type {
  AccessScope,
  ApiConfig,
  ApiRequest,
  ApiStore,
  StoredTask,
  TaskCreation,
  PostFundingCoordinator,
} from "../../apps/api/src/types.ts"
import type { CommerceCompatibility } from "../../packages/commerce/src/index.ts"
import type { ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"
import type { TaskSpec } from "../../packages/contracts/src/task.ts"
import type {
  ServiceRequestCreation,
  VerifiedQuoteCreation,
  VerifiedQuoteRecord,
} from "../../packages/db/src/index.ts"
import {
  buyerIntentBodySha256,
  buyerIntentMessage,
  buyerResourcePrefix,
  encodeBuyerIntent,
  type BuyerIntent,
  type BuyerIntentAction,
} from "../../packages/security/src/buyer-intent.ts"

const token = "self-service-test-token-that-is-at-least-32-characters"
const origin = "https://knotmarkets.xyz"
const now = new Date("2026-09-13T12:00:00.000Z")
const sellerEndpoint = "https://knot-health.truematchx.com/"
const digest = `0x${"a".repeat(64)}` as const
const seller = "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389" as const
const currency = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" as const
const policy = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"

const buyerA = privateKeyToAccount(`0x${"11".repeat(32)}`)
const buyerB = privateKeyToAccount(`0x${"22".repeat(32)}`)

const compatibility = (): CommerceCompatibility => ({
  status: "VERIFIED",
  writeAllowed: true,
  chainId: 97,
  blockNumber: "130000000",
  observedAtUtc: now.toISOString(),
  sdkVersions: null,
  selectedPolicy: policy,
  declarationConflict: false,
  reasons: [],
  policies: [{
    address: policy,
    declaredBy: ["@bnbagent/sdk"],
    codeHash: null,
    whitelisted: true,
    commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
    router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25",
    disputeWindowSeconds: "900",
    compatible: true,
  }],
})

const quoteRecord = (
  id: string,
  buyer: `0x${string}`,
  taskId: string,
  quoteExpiresAtUnix = Math.floor(Date.parse("2026-09-13T12:10:00.000Z") / 1_000),
): VerifiedQuoteRecord => ({
  id,
  serviceRequestId: id,
  buyer,
  taskId,
  sellerEndpoint,
  providerAgentId: "owned_healthguard_2295",
  sellerIdentityChainId: 97,
  sellerRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  sellerAgentId: "2295",
  sellerOwner: seller,
  identityObservationId: "erc8004_2295_130090000_1212121212121212",
  identityBlockNumber: "130090000",
  identityBlockHash: `0x${"12".repeat(32)}`,
  identityObservedAt: new Date("2026-09-13T11:59:30.000Z"),
  quote: {
    response: {
      terms: { price: "100000000000000000", currency },
      quote_expires_at: quoteExpiresAtUnix,
    },
  },
  requestHash: `0x${"23".repeat(32)}`,
  responseHash: `0x${"34".repeat(32)}`,
  negotiationHash: `0x${"45".repeat(32)}`,
  jobDescriptionSha256: `0x${"56".repeat(32)}`,
  canonicalJobDescription: "KNOT verified hire: HealthGuard analysis",
  verifierVersion: "knot.owned-seller-quote/2",
  verifiedAt: now,
  expiresAtUnix: quoteExpiresAtUnix.toString(),
  fundingPermitted: false,
} as unknown as VerifiedQuoteRecord)

class SelfServiceStore implements ApiStore {
  readonly tasks = new Map<string, StoredTask>()
  readonly serviceRequests = new Set<string>()
  readonly quotes = new Map<string, VerifiedQuoteRecord>()
  readonly buyersSeen: string[] = []
  quoteNegotiations = 0

  async status() {}

  async createTask(buyer: string, task: TaskSpec, accessScope: AccessScope): Promise<TaskCreation> {
    this.buyersSeen.push(buyer)
    const existing = this.tasks.get(task.taskId)
    if (existing) return { task: existing, created: false }
    const stored = { buyer, task, accessScope, createdAt: now }
    this.tasks.set(task.taskId, stored)
    return { task: stored, created: true }
  }

  async getTask(taskId: string, buyer: string) {
    const task = this.tasks.get(taskId)
    return task?.buyer.toLowerCase() === buyer.toLowerCase() ? task : null
  }

  async createServiceRequest(input: { id: string; buyer: string }): Promise<ServiceRequestCreation> {
    this.buyersSeen.push(input.buyer)
    const created = !this.serviceRequests.has(input.id)
    this.serviceRequests.add(input.id)
    return { record: {} as ServiceRequestCreation["record"], created }
  }

  async getServiceRequest() {
    return null
  }

  async createVerifiedQuote(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteCreation> {
    this.buyersSeen.push(buyer)
    const existing = this.quotes.get(serviceRequestId)
    if (existing) return { record: existing, created: false }
    this.quoteNegotiations += 1
    const taskId = [...this.tasks.keys()][0] ?? "missing"
    const record = quoteRecord(serviceRequestId, buyer as `0x${string}`, taskId)
    this.quotes.set(serviceRequestId, record)
    return { record, created: true }
  }

  async getVerifiedQuote(id: string, buyer: string) {
    this.buyersSeen.push(buyer)
    const quote = this.quotes.get(id)
    return quote?.buyer.toLowerCase() === buyer.toLowerCase() ? quote : null
  }

  async getJob() {
    return null
  }
}

const config: ApiConfig = {
  authToken: token,
  buyerAddress: "0x9999999999999999999999999999999999999999",
  allowedOrigin: origin,
  maxBodyBytes: 65_536,
  now: () => now,
  commerceProbe: async () => compatibility(),
}

const postFunding: PostFundingCoordinator = {
  async confirm(input) { return { status: 200, body: { buyer: input.buyer, verifiedQuoteId: input.verifiedQuote.id } } },
  async status(record, owner) { return { status: 200, body: { buyer: owner, verifiedQuoteId: record.id } } },
}

const quotePayload = (buyer: `0x${string}`) => {
  const prefix = buyerResourcePrefix(buyer)
  const taskId = `${prefix}task_1`
  const serviceRequestId = `${prefix}request_1`
  const task: TaskSpec = {
    schemaVersion: "knot.task/1",
    taskId,
    category: "health",
    capability: "analysis",
    identityChainId: 97,
    dataChainId: 56,
    paymentChainId: 97,
    executionChainId: null,
    target: {
      borrower: buyer,
      comptroller: "0xfd36e2c2a6789db23113685031d7f16329158384",
      poolFamily: "venus-core",
    },
    constraints: {
      safetyThresholdRatio: 1.5,
      actionThresholdRatio: 1.2,
      repaymentAsset: currency,
      maxRepaymentUnits: "1000000000000000000",
      gasBudgetWei: "5000000000000000",
      pollIntervalSeconds: 300,
      mode: "notify",
    },
    serviceFeeLimit: { chainId: 97, token: currency, units: "100000000000000000", decimals: 18 },
    managedPrincipal: [],
    executionSpendLimits: [],
    deadlineUtc: "2030-01-01T00:00:00.000Z",
    inputHash: digest,
    snapshotId: null,
  }
  const envelope: ServiceRequestEnvelope = {
    schemaVersion: "knot.service-request/1",
    task,
    request: {
      mediaType: "application/json",
      schemaVersion: "knot.health.request/1",
      bytesBase64url: Buffer.from("{}", "utf8").toString("base64url"),
    },
    transport: "base64url",
  }
  const value = {
    task,
    accessScope: { visibility: "PRIVATE" as const },
    serviceRequest: { id: serviceRequestId, endpoint: sellerEndpoint, envelope },
  }
  return { body: JSON.stringify(value), serviceRequestId, taskId }
}

const signRequest = async (
  account: typeof buyerA,
  action: BuyerIntentAction,
  resourceId: string,
  body: string,
  overrides: Partial<BuyerIntent> = {},
): Promise<ApiRequest> => {
  const intent: BuyerIntent = {
    schemaVersion: "knot.buyer-intent/1",
    buyer: account.address,
    chainId: 97,
    origin,
    action,
    resourceId,
    idempotencyKey: resourceId,
    bodySha256: buyerIntentBodySha256(body),
    issuedAtUtc: "2026-09-13T11:59:30.000Z",
    expiresAtUtc: "2026-09-13T12:03:30.000Z",
    ...overrides,
  }
  const signature = await account.signMessage({ message: buyerIntentMessage(intent) })
  return {
    method: "POST",
    path: action === "CREATE_VERIFIED_QUOTE"
      ? "/api/self-service/verified-quotes"
      : action === "PREPARE_HIRE"
        ? `/api/self-service/verified-quotes/${resourceId}/hire-preparation`
        : action === "CONFIRM_FUNDING"
          ? `/api/self-service/verified-quotes/${resourceId}/funding-confirmation`
          : `/api/self-service/verified-quotes/${resourceId}/hire-status`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin,
      "idempotency-key": resourceId,
      "x-knot-buyer-intent": encodeBuyerIntent(intent),
      "x-knot-buyer-signature": signature,
    },
    body,
  }
}

describe("self-service buyer binding", () => {
  it("derives the buyer from a signature and makes exact replay idempotent", async () => {
    const store = new SelfServiceStore()
    const payload = quotePayload(buyerA.address)
    const request = await signRequest(buyerA, "CREATE_VERIFIED_QUOTE", payload.serviceRequestId, payload.body)
    const handle = createApiHandler(store, config)
    const first = await handle(request)
    const replay = await handle(request)
    assert.equal(first.status, 201, first.body)
    assert.equal(replay.status, 200)
    assert.equal(store.quoteNegotiations, 1)
    assert.ok(store.buyersSeen.every((value) => value.toLowerCase() === buyerA.address.toLowerCase()))
    const response = JSON.parse(first.body) as { buyer: string; buyerBinding: { chainId: number; method: string } }
    assert.equal(response.buyer, buyerA.address)
    assert.deepEqual(response.buyerBinding, {
      method: "EIP-191",
      chainId: 97,
      action: "CREATE_VERIFIED_QUOTE",
      resourceId: payload.serviceRequestId,
    })
    assert.doesNotMatch(first.body, /x-knot-buyer-signature|privateKey|signature\"/i)
  })

  it("rejects missing, expired, tampered, wrong-network, and cross-origin authority before persistence", async () => {
    const payload = quotePayload(buyerA.address)
    const valid = await signRequest(buyerA, "CREATE_VERIFIED_QUOTE", payload.serviceRequestId, payload.body)
    const expired = await signRequest(buyerA, "CREATE_VERIFIED_QUOTE", payload.serviceRequestId, payload.body, {
      issuedAtUtc: "2026-09-13T11:50:00.000Z",
      expiresAtUtc: "2026-09-13T11:55:00.000Z",
    })
    const decoded = JSON.parse(Buffer.from(valid.headers["x-knot-buyer-intent"]!, "base64url").toString("utf8")) as BuyerIntent
    const wrongNetwork = {
      ...valid,
      headers: {
        ...valid.headers,
        "x-knot-buyer-intent": Buffer.from(JSON.stringify({ ...decoded, chainId: 56 }), "utf8").toString("base64url"),
      },
    }
    const attempts: ApiRequest[] = [
      { ...valid, headers: { ...valid.headers, "x-knot-buyer-signature": undefined } },
      expired,
      { ...valid, body: `${payload.body} ` },
      wrongNetwork,
      { ...valid, headers: { ...valid.headers, origin: "https://attacker.example" } },
    ]
    for (const request of attempts) {
      const store = new SelfServiceStore()
      const response = await createApiHandler(store, config)(request)
      assert.ok([400, 401, 403].includes(response.status), `${response.status}: ${response.body}`)
      assert.equal(store.tasks.size, 0)
      assert.equal(store.quoteNegotiations, 0)
    }
  })

  it("never returns or prepares buyer A's quote for buyer B", async () => {
    const store = new SelfServiceStore()
    const payload = quotePayload(buyerA.address)
    store.quotes.set(payload.serviceRequestId, quoteRecord(payload.serviceRequestId, buyerA.address, payload.taskId))
    const request = await signRequest(buyerB, "PREPARE_HIRE", payload.serviceRequestId, "{}")
    const response = await createApiHandler(store, config)(request)
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(response.body).code, "RESOURCE_NOT_FOUND")
    assert.equal(store.buyersSeen.at(-1), buyerB.address)
  })

  it("refuses a quote that expires after binding but before hire preparation", async () => {
    const store = new SelfServiceStore()
    const payload = quotePayload(buyerA.address)
    store.quotes.set(
      payload.serviceRequestId,
      quoteRecord(payload.serviceRequestId, buyerA.address, payload.taskId, Math.floor(now.getTime() / 1_000)),
    )
    const request = await signRequest(buyerA, "PREPARE_HIRE", payload.serviceRequestId, "{}")
    const response = await createApiHandler(store, config)(request)
    assert.equal(response.status, 409)
    assert.match(response.body, /QUOTE_EXPIRED/)
  })

  it("binds funding confirmation and status reads to the recovered quote owner", async () => {
    const store = new SelfServiceStore()
    const payload = quotePayload(buyerA.address)
    store.quotes.set(payload.serviceRequestId, quoteRecord(payload.serviceRequestId, buyerA.address, payload.taskId))
    const fundingBody = JSON.stringify({
      creationTransactionHash: `0x${"01".repeat(32)}`,
      fundingTransactionHashes: [
        `0x${"02".repeat(32)}`,
        `0x${"03".repeat(32)}`,
        `0x${"04".repeat(32)}`,
        `0x${"05".repeat(32)}`,
      ],
    })
    const fundingRequest = await signRequest(buyerA, "CONFIRM_FUNDING", payload.serviceRequestId, fundingBody)
    const statusRequest = await signRequest(buyerA, "READ_HIRE_STATUS", payload.serviceRequestId, "{}")
    const handler = createApiHandler(store, { ...config, postFunding })
    const [funding, status] = await Promise.all([handler(fundingRequest), handler(statusRequest)])
    assert.equal(funding.status, 200, funding.body)
    assert.equal(status.status, 200, status.body)
    assert.equal(JSON.parse(funding.body).buyer, buyerA.address)
    assert.equal(JSON.parse(status.body).buyer, buyerA.address)

    const stolen = await signRequest(buyerB, "READ_HIRE_STATUS", payload.serviceRequestId, "{}")
    const denied = await handler(stolen)
    assert.equal(denied.status, 404)
  })

  it("rejects duplicate funding hashes before calling post-funding verification", async () => {
    const store = new SelfServiceStore()
    const payload = quotePayload(buyerA.address)
    store.quotes.set(payload.serviceRequestId, quoteRecord(payload.serviceRequestId, buyerA.address, payload.taskId))
    const hash = `0x${"06".repeat(32)}`
    const body = JSON.stringify({ creationTransactionHash: hash, fundingTransactionHashes: [hash, hash, hash, hash] })
    const request = await signRequest(buyerA, "CONFIRM_FUNDING", payload.serviceRequestId, body)
    const response = await createApiHandler(store, { ...config, postFunding })(request)
    assert.equal(response.status, 400)
  })
})
