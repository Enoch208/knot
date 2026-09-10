import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { after, before, describe, it, test } from "node:test"
import { NegotiationHandler } from "@bnbagent/sdk/erc8183"
import { privateKeyToAccount } from "viem/accounts"
import { TESTNET } from "../../packages/chain/src/manifest.ts"
import type { Erc8004IdentityObservation } from "../../packages/chain/src/erc8004-identity.ts"
import { resolveTestnetSdkSource, TESTNET_CODE_SNAPSHOT } from "../../packages/commerce/src/deployments.ts"
import { prepareServiceRequest, type ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import {
  ServiceRequestRepository,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/src/index.ts"
import {
  expectedPublicSellers,
  type ExpectedPublicSeller,
} from "../../packages/discovery/src/public-sellers.ts"
import { PgVerifiedQuotePersistence } from "../../apps/api/src/verified-quote-persistence.ts"
import { VerifiedQuoteOrchestrator } from "../../apps/api/src/verified-quote-orchestrator.ts"

const connectionString = process.env.KNOT_TEST_DATABASE_URL?.trim()

if (!connectionString) {
  test("verified quote orchestration PostgreSQL persistence", { skip: "KNOT_TEST_DATABASE_URL is required" }, () => undefined)
}

const integration = connectionString ? describe : describe.skip

integration("verified quote orchestration PostgreSQL persistence", () => {
  const pool = createDatabasePool(connectionString as string, { max: 4 })
  const buyer = "0x1111111111111111111111111111111111111111"
  const provider = privateKeyToAccount(`0x${"34".repeat(32)}`)
  const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
  const now = new Date()
  const observedAt = new Date(now.getTime() - 1_000)
  const retainedTask = taskSpec.parse({
    ...(JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as Record<string, unknown>),
    deadlineUtc: "2030-01-01T00:00:00.000Z",
  })
  const requestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
  const envelope: ServiceRequestEnvelope = {
    schemaVersion: "knot.service-request/1",
    task: retainedTask,
    request: {
      mediaType: "application/json",
      schemaVersion: "knot.rangepilot.request/1",
      bytesBase64url: requestBytes.toString("base64url"),
    },
    transport: "deflate-base64url",
  }
  const serviceRequestId = `request_${randomUUID()}`
  const failedServiceRequestId = `request_${randomUUID()}`
  const identity: Erc8004IdentityObservation = {
    schemaVersion: "knot.erc8004-identity-observation/1",
    status: "VERIFIED",
    chainId: 97,
    registry: deployment.registry.toLowerCase() as `0x${string}`,
    agentId: "2297",
    owner: provider.address.toLowerCase() as `0x${string}`,
    ownerAccountType: "EOA",
    agentWallet: provider.address.toLowerCase() as `0x${string}`,
    tokenURI: "data:application/json;base64,e30=",
    blockNumber: "130090000",
    blockHash: `0x${"12".repeat(32)}`,
    blockTimestampUtc: new Date(observedAt.getTime() - 3_000).toISOString(),
    confirmationDepth: 3,
    observedAtUtc: observedAt.toISOString(),
    registryDeployment: {
      proxyCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registry,
      implementation: deployment.registryImplementation.toLowerCase() as `0x${string}`,
      implementationCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registryImplementation,
    },
    rpcSources: [TESTNET.rpcUrls[0]!, TESTNET.rpcUrls[1]!],
    method: "eth_call@confirmed-block+block-hash-recheck+dual-rpc-agreement",
  }
  const productionSeller = expectedPublicSellers.find((seller) => seller.key === "rangepilot")
  if (productionSeller === undefined) throw new Error("rangepilot authority is unavailable")
  const testSeller: ExpectedPublicSeller = Object.freeze({
    ...productionSeller,
    owner: provider.address.toLowerCase() as `0x${string}`,
  })
  const resolveTestSeller = (
    category: ServiceRequestEnvelope["task"]["category"],
    endpoint: string,
  ): ExpectedPublicSeller | null => {
    const normalized = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
    return category === testSeller.category && normalized === testSeller.origin ? testSeller : null
  }
  let sellerCalls = 0

  before(async () => {
    await migrateDatabase(pool)
    await pool.query(
      "INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, execution_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, '{\"visibility\":\"PRIVATE\"}'::jsonb, $12)",
      [retainedTask.taskId, buyer, retainedTask.schemaVersion, retainedTask.category, retainedTask.capability, retainedTask.identityChainId, retainedTask.dataChainId, retainedTask.paymentChainId, retainedTask.executionChainId, retainedTask.inputHash, JSON.stringify(retainedTask), retainedTask.deadlineUtc],
    )
    const requests = new ServiceRequestRepository(pool, () => now)
    await requests.create({ id: serviceRequestId, buyer, endpoint: "https://knot-range.truematchx.com", idempotencyKey: serviceRequestId, envelope })
    await requests.create({ id: failedServiceRequestId, buyer, endpoint: "https://knot-range.truematchx.com", idempotencyKey: failedServiceRequestId, envelope })
  })

  after(async () => {
    await pool.end()
  })

  const config = {
    enabled: true as const,
    credentials: {
      healthguard: { clientId: "health", clientSecret: "health-secret-0001" },
      rangepilot: { clientId: "range", clientSecret: "range-secret-00001" },
      gridquant: { clientId: "grid", clientSecret: "grid-secret-000001" },
      yieldscout: { clientId: "yield", clientSecret: "yield-secret-00001" },
    },
  }

  const createOrchestrator = (invalidQuote = false, clock: () => Date = () => now) =>
    new VerifiedQuoteOrchestrator(new PgVerifiedQuotePersistence(pool, clock, resolveTestSeller), config, {
      collectIdentity: async () => identity,
      resolveSellerAuthority: resolveTestSeller,
      createClient: () => ({
        negotiate: async (input) => {
          sellerCalls += 1
          if (invalidQuote) {
            return {
              payload: { invalid: true },
              metrics: {
                sellerKey: "rangepilot",
                oauthLatencyMilliseconds: 10,
                invocationLatencyMilliseconds: 20,
                responseByteLength: 16,
                responseSha256: `0x${"67".repeat(32)}`,
              },
            }
          }
          const data = input.data as { request: Record<string, unknown> }
          const handler = new NegotiationHandler({
            servicePrice: retainedTask.serviceFeeLimit.units,
            currency: retainedTask.serviceFeeLimit.token,
            estimatedCompletionSeconds: 60,
            quoteTtlSeconds: 600,
            chainId: 97,
            verifyingContract: deployment.commerce,
            now: () => Math.floor(now.getTime() / 1_000),
            walletProvider: {
              address: provider.address,
              signMessage: async (message: string) => ({ signature: await provider.signMessage({ message }) }),
            },
          })
          return {
            payload: (await handler.negotiate(data.request)).toDict(),
            metrics: {
              sellerKey: "rangepilot",
              oauthLatencyMilliseconds: 10,
              invocationLatencyMilliseconds: 20,
              responseByteLength: 4096,
              responseSha256: `0x${"67".repeat(32)}`,
            },
          }
        },
      }),
    })

  it("rolls back agent promotion and all observations when quote verification fails", async () => {
    await assert.rejects(() => createOrchestrator(true).create(failedServiceRequestId, buyer))
    const counts = await pool.query<{
      agents: string
      identities: string
      endpoints: string
      verified: string
      jobs: string
      outbox: string
      actions: string
    }>("SELECT (SELECT count(*) FROM agents WHERE id = 'owned_rangepilot_2297')::text AS agents, (SELECT count(*) FROM erc8004_identity_observations WHERE agent_record_id = 'owned_rangepilot_2297')::text AS identities, (SELECT count(*) FROM endpoint_observations WHERE agent_id = 'owned_rangepilot_2297')::text AS endpoints, (SELECT count(*) FROM verified_quotes WHERE service_request_id = $1)::text AS verified, (SELECT count(*) FROM jobs)::text AS jobs, (SELECT count(*) FROM outbox)::text AS outbox, (SELECT count(*) FROM chain_actions)::text AS actions", [failedServiceRequestId])
    assert.deepEqual(counts.rows[0], {
      agents: "0",
      identities: "0",
      endpoints: "0",
      verified: "0",
      jobs: "0",
      outbox: "0",
      actions: "0",
    })
    sellerCalls = 0
  })

  it("serializes concurrent negotiation, persists one trusted pair, and keeps funding surfaces untouched", async () => {
    const orchestrator = createOrchestrator()
    const [first, second] = await Promise.all([
      orchestrator.create(serviceRequestId, buyer),
      orchestrator.create(serviceRequestId, buyer),
    ])
    assert.equal([first.created, second.created].filter(Boolean).length, 1)
    assert.equal(sellerCalls, 1)
    assert.equal(first.record.id, serviceRequestId)
    assert.equal(second.record.id, serviceRequestId)
    assert.equal(first.record.identityObservationId, second.record.identityObservationId)
    assert.equal(first.record.fundingPermitted, false)
    const counts = await pool.query<{
      agents: string
      identities: string
      endpoints: string
      verified: string
      jobs: string
      legacy_quotes: string
      outbox: string
      actions: string
    }>("SELECT (SELECT count(*) FROM agents WHERE id = 'owned_rangepilot_2297')::text AS agents, (SELECT count(*) FROM erc8004_identity_observations WHERE agent_record_id = 'owned_rangepilot_2297')::text AS identities, (SELECT count(*) FROM endpoint_observations WHERE agent_id = 'owned_rangepilot_2297')::text AS endpoints, (SELECT count(*) FROM verified_quotes WHERE service_request_id = $1)::text AS verified, (SELECT count(*) FROM jobs)::text AS jobs, (SELECT count(*) FROM quotes)::text AS legacy_quotes, (SELECT count(*) FROM outbox)::text AS outbox, (SELECT count(*) FROM chain_actions)::text AS actions", [serviceRequestId])
    assert.deepEqual(counts.rows[0], {
      agents: "1",
      identities: "1",
      endpoints: "1",
      verified: "1",
      jobs: "0",
      legacy_quotes: "0",
      outbox: "0",
      actions: "0",
    })
  })

  it("returns an expired exact retry without another seller call", async () => {
    const before = sellerCalls
    const later = createOrchestrator(false, () => new Date("2031-01-01T00:00:00.000Z"))
    const result = await later.create(serviceRequestId, buyer)
    assert.equal(result.created, false)
    assert.equal(result.record.id, serviceRequestId)
    assert.equal(sellerCalls, before)
  })

  it("rolls back endpoint and quote persistence when cryptographic verification fails", async () => {
    await assert.rejects(() => createOrchestrator(true).create(failedServiceRequestId, buyer))
    const rows = await pool.query<{ endpoints: string; verified: string }>(
      "SELECT (SELECT count(*) FROM endpoint_observations WHERE id <> $1)::text AS endpoints, (SELECT count(*) FROM verified_quotes WHERE service_request_id = $2)::text AS verified",
      [`endpoint_${sha256ForTest(`${buyer}:${serviceRequestId}`).slice(0, 32)}`, failedServiceRequestId],
    )
    assert.deepEqual(rows.rows[0], { endpoints: "0", verified: "0" })
  })
})

const sha256ForTest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")
