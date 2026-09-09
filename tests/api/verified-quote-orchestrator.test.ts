import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Erc8004IdentityObservation } from "../../packages/chain/src/erc8004-identity.ts"
import { prepareServiceRequest } from "../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import type { ServiceRequestRecord, VerifiedQuoteRecord } from "../../packages/db/src/index.ts"
import {
  VerifiedQuoteOrchestrationError,
  VerifiedQuoteOrchestrator,
  type LockedVerifiedQuotePersistence,
  type PersistVerifiedOwnedSellerQuoteInput,
  type VerifiedQuotePersistence,
} from "../../apps/api/src/verified-quote-orchestrator.ts"

const buyer = "0x1111111111111111111111111111111111111111"
const retainedTask = taskSpec.parse({
  ...(JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as Record<string, unknown>),
  deadlineUtc: "2030-01-01T00:00:00.000Z",
})
const requestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
const prepared = prepareServiceRequest({
  schemaVersion: "knot.service-request/1",
  task: retainedTask,
  request: {
    mediaType: "application/json",
    schemaVersion: "knot.rangepilot.request/1",
    bytesBase64url: requestBytes.toString("base64url"),
  },
  transport: "deflate-base64url",
}, buyer)

const serviceRequest = (endpoint = "https://knot-range.truematchx.com/"): ServiceRequestRecord => ({
  id: "request_range_orchestrated",
  buyer: prepared.buyer,
  endpoint,
  idempotencyKey: "request_range_orchestrated",
  taskId: prepared.taskId,
  task: prepared.task,
  category: prepared.category,
  requestSchemaVersion: prepared.requestSchemaVersion,
  transport: prepared.transport,
  requestBytes: Buffer.from(prepared.requestBytesBase64url, "base64url"),
  requestSha256: prepared.requestSha256,
  requestKeccak256: prepared.requestKeccak256,
  taskDescription: prepared.taskDescription,
  taskDescriptionSha256: prepared.taskDescriptionSha256,
  snapshotId: prepared.snapshotId,
  taskInputHash: prepared.taskInputHash as `0x${string}`,
  inputBinding: prepared.inputBinding,
  createdAt: new Date("2026-09-09T20:00:00.000Z"),
})

const identity = (agentId = "2297"): Erc8004IdentityObservation => ({
  schemaVersion: "knot.erc8004-identity-observation/1",
  status: "VERIFIED",
  chainId: 97,
  registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  agentId,
  owner: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  ownerAccountType: "EOA",
  agentWallet: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  tokenURI: "data:application/json;base64,e30=",
  blockNumber: "130090000",
  blockHash: `0x${"12".repeat(32)}`,
  blockTimestampUtc: "2026-09-09T19:59:57.000Z",
  confirmationDepth: 3,
  observedAtUtc: "2026-09-09T20:00:00.000Z",
  registryDeployment: {
    proxyCodeHash: `0x${"34".repeat(32)}`,
    implementation: "0x7274e874ca62410a93bd8bf61c69d8045e399c02",
    implementationCodeHash: `0x${"56".repeat(32)}`,
  },
  rpcSources: [
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet-dataseed.bnbchain.org",
  ],
  method: "eth_call@confirmed-block+block-hash-recheck+dual-rpc-agreement",
})

const quoteRecord = { id: "request_range_orchestrated", fundingPermitted: false } as VerifiedQuoteRecord

class MemoryPersistence implements VerifiedQuotePersistence, LockedVerifiedQuotePersistence {
  existing: VerifiedQuoteRecord | null = null
  request: ServiceRequestRecord | null = serviceRequest()
  lockCalls = 0
  persistCalls = 0
  persisted: PersistVerifiedOwnedSellerQuoteInput | null = null

  async withServiceRequestLock<T>(
    _buyer: string,
    _serviceRequestId: string,
    operation: (locked: LockedVerifiedQuotePersistence) => Promise<T>,
  ): Promise<T> {
    this.lockCalls += 1
    return operation(this)
  }

  async getExistingQuote(): Promise<VerifiedQuoteRecord | null> {
    return this.existing
  }

  async getServiceRequest(): Promise<ServiceRequestRecord | null> {
    return this.request
  }

  async persistVerifiedQuote(input: PersistVerifiedOwnedSellerQuoteInput) {
    this.persistCalls += 1
    this.persisted = input
    return { record: quoteRecord, created: true }
  }
}

const config = {
  enabled: true as const,
  credentials: {
    healthguard: { clientId: "health", clientSecret: "health-secret-0001" },
    rangepilot: { clientId: "range", clientSecret: "range-secret-00001" },
    gridquant: { clientId: "grid", clientSecret: "grid-secret-000001" },
    yieldscout: { clientId: "yield", clientSecret: "yield-secret-00001" },
  },
}

describe("VerifiedQuoteOrchestrator", () => {
  it("returns an exact stored quote without identity or seller egress", async () => {
    const persistence = new MemoryPersistence()
    persistence.existing = quoteRecord
    let identityCalls = 0
    let clientCalls = 0
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      collectIdentity: async () => {
        identityCalls += 1
        return identity()
      },
      createClient: () => ({
        negotiate: async () => {
          clientCalls += 1
          throw new Error("unexpected seller call")
        },
      }),
    })
    const result = await orchestrator.create(serviceRequest().id, buyer)
    assert.equal(result.created, false)
    assert.equal(result.record, quoteRecord)
    assert.equal(persistence.lockCalls, 1)
    assert.equal(identityCalls, 0)
    assert.equal(clientCalls, 0)
  })

  it("rejects unsealed endpoints before identity, credentials, or persistence", async () => {
    const persistence = new MemoryPersistence()
    persistence.request = serviceRequest("https://knot-range.truematchx.com.attacker.example/")
    let identityCalls = 0
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      collectIdentity: async () => {
        identityCalls += 1
        return identity()
      },
    })
    await assert.rejects(
      () => orchestrator.create(serviceRequest().id, buyer),
      (error: unknown) => error instanceof VerifiedQuoteOrchestrationError && error.code === "SELLER_AUTHORITY_MISMATCH",
    )
    assert.equal(identityCalls, 0)
    assert.equal(persistence.persistCalls, 0)
  })

  it("binds the stored request, sealed seller, confirmed identity, and untrusted quote payload", async () => {
    const persistence = new MemoryPersistence()
    let clientKey = ""
    let capturedData: Readonly<Record<string, unknown>> | null = null
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      collectIdentity: async () => identity(),
      createClient: (seller) => {
        clientKey = seller.key
        return {
          negotiate: async (input) => {
            capturedData = input.data
            return {
              payload: { quote: "untrusted-until-persistence" },
              metrics: {
                sellerKey: seller.key,
                oauthLatencyMilliseconds: 10,
                invocationLatencyMilliseconds: 20,
                responseByteLength: 100,
                responseSha256: `0x${"78".repeat(32)}`,
              },
            }
          },
        }
      },
    })
    const result = await orchestrator.create(serviceRequest().id, buyer)
    assert.equal(result.created, true)
    assert.equal(clientKey, "rangepilot")
    assert.equal(persistence.persistCalls, 1)
    assert.deepEqual(capturedData, {
      skill: "negotiate",
      request: {
        task_description: serviceRequest().taskDescription,
        terms: persistence.persisted?.negotiationRequest.request.terms,
        request_id: serviceRequest().id,
      },
    })
    assert.equal(persistence.persisted?.identity.owner, identity().owner)
    assert.deepEqual(persistence.persisted?.negotiationResult.payload, { quote: "untrusted-until-persistence" })
  })

  it("rejects a mismatched observed agent before OAuth", async () => {
    const persistence = new MemoryPersistence()
    let clientCalls = 0
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      collectIdentity: async () => identity("2298"),
      createClient: () => {
        clientCalls += 1
        throw new Error("unexpected client creation")
      },
    })
    await assert.rejects(
      () => orchestrator.create(serviceRequest().id, buyer),
      (error: unknown) => error instanceof VerifiedQuoteOrchestrationError && error.code === "IDENTITY_MISMATCH",
    )
    assert.equal(clientCalls, 0)
    assert.equal(persistence.persistCalls, 0)
  })

  it("rejects a transferred owner before credentials or persistence", async () => {
    const persistence = new MemoryPersistence()
    let clientCalls = 0
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      collectIdentity: async () => ({
        ...identity(),
        owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      createClient: () => {
        clientCalls += 1
        throw new Error("unexpected client creation")
      },
    })
    await assert.rejects(
      () => orchestrator.create(serviceRequest().id, buyer),
      (error: unknown) => error instanceof VerifiedQuoteOrchestrationError && error.code === "IDENTITY_MISMATCH",
    )
    assert.equal(clientCalls, 0)
    assert.equal(persistence.persistCalls, 0)
  })

  it("rejects an expired request before identity collection or credential use while preserving stored retries", async () => {
    const persistence = new MemoryPersistence()
    let identityCalls = 0
    let clientCalls = 0
    const orchestrator = new VerifiedQuoteOrchestrator(persistence, config, {
      now: () => new Date("2031-01-01T00:00:00.000Z"),
      collectIdentity: async () => {
        identityCalls += 1
        return identity()
      },
      createClient: () => {
        clientCalls += 1
        throw new Error("unexpected client creation")
      },
    })
    await assert.rejects(
      () => orchestrator.create(serviceRequest().id, buyer),
      (error: unknown) => error instanceof VerifiedQuoteOrchestrationError && error.code === "REQUEST_EXPIRED",
    )
    assert.equal(identityCalls, 0)
    assert.equal(clientCalls, 0)
    assert.equal(persistence.persistCalls, 0)
    persistence.existing = quoteRecord
    const retry = await orchestrator.create(serviceRequest().id, buyer)
    assert.equal(retry.created, false)
    assert.equal(retry.record, quoteRecord)
  })
})
