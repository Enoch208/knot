import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { NegotiationHandler } from "@bnbagent/sdk/erc8183"
import type { Pool } from "pg"
import { privateKeyToAccount } from "viem/accounts"
import { prepareServiceRequest, type ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import { IdempotencyConflictError, VerifiedQuoteRepository } from "../../packages/db/src/index.ts"

const NOW = 1_788_985_000
const buyer = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
const endpoint = "https://knot-range.truematchx.com/"
const commerce = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE"
const registry = "0x1212121212121212121212121212121212121212"
const provider = privateKeyToAccount(`0x${"34".repeat(32)}`)
const serviceRequestId = "service_request_quote_0001"
const providerAgentId = "provider_agent_quote_0001"
const endpointObservationId = "endpoint_quote_0001"
const identityObservationId = "identity_quote_0001"
const quoteId = "verified_quote_0001"
const requestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
const retainedTask = taskSpec.parse(JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as unknown)
const task = taskSpec.parse({ ...retainedTask, deadlineUtc: "2030-01-01T00:00:00.000Z" })
const envelope: ServiceRequestEnvelope = {
  schemaVersion: "knot.service-request/1",
  task,
  request: {
    mediaType: "application/json",
    schemaVersion: "knot.rangepilot.request/1",
    bytesBase64url: requestBytes.toString("base64url"),
  },
  transport: "deflate-base64url",
}
const prepared = prepareServiceRequest(envelope, buyer)
const requestedTerms = {
  deliverables: "One deterministic RangePilot analysis artifact.",
  quality_standards: "Closed schema, pinned inputs, and fail-closed output.",
  success_criteria: ["The task and input commitment match."],
}
const now = new Date((NOW + 1) * 1_000)

const signedQuote = async (negotiatedAt = NOW) => {
  const sentRequest = {
    task_description: prepared.taskDescription,
    terms: requestedTerms,
    request_id: serviceRequestId,
  }
  const handler = new NegotiationHandler({
    servicePrice: task.serviceFeeLimit.units,
    currency: task.serviceFeeLimit.token,
    estimatedCompletionSeconds: 600,
    quoteTtlSeconds: 900,
    chainId: 97,
    verifyingContract: commerce,
    now: () => negotiatedAt,
    walletProvider: {
      address: provider.address,
      signMessage: async (message: string) => ({ signature: await provider.signMessage({ message }) }),
    },
  })
  return { sentRequest, quote: (await handler.negotiate(sentRequest)).toDict() }
}

class VerifiedQuotePool {
  readonly records = new Map<string, Record<string, unknown>>()
  readonly context = {
    service_request_id: serviceRequestId,
    buyer: buyer.toLowerCase(),
    seller_endpoint: endpoint,
    task_id: task.taskId,
    task_description: prepared.taskDescription,
    task_description_sha256: prepared.taskDescriptionSha256,
    task_spec: task,
    task_deadline_at: new Date(task.deadlineUtc),
    provider_agent_id: providerAgentId,
    seller_identity_chain_id: 97,
    seller_registry: registry.toLowerCase(),
    seller_agent_id: "2297",
    seller_owner: provider.address.toLowerCase(),
    operator_relation: "KNOT_OPERATED",
    agent_status: "HIREABLE",
    identity_observation_id: identityObservationId,
    identity_agent_record_id: providerAgentId,
    identity_chain_id: 97,
    identity_registry: registry.toLowerCase(),
    identity_agent_id: "2297",
    identity_owner: provider.address.toLowerCase(),
    identity_operator_relation: "KNOT_OPERATED",
    identity_block_number: "130100000",
    identity_block_hash: `0x${"56".repeat(32)}`,
    identity_observed_at: new Date((NOW - 5) * 1_000),
    identity_status: "CONFIRMED",
    endpoint_observation_id: endpointObservationId,
    endpoint_request_type: "negotiate",
    endpoint_result: "SUCCESS",
    endpoint_observed_at: new Date((NOW - 10) * 1_000),
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.startsWith("SELECT sr.id AS service_request_id")) {
      return { rows: values[4] === identityObservationId ? [this.context] : [] }
    }
    if (text.startsWith("INSERT INTO verified_quotes")) {
      const conflict = [...this.records.values()].some((row) =>
        row.buyer === values[2] &&
        row.service_request_id === values[1] &&
        row.idempotency_key === values[35],
      ) || [...this.records.values()].some((row) =>
        row.chain_id === values[28] && row.commerce === values[29] && row.negotiation_hash === values[22],
      )
      if (conflict) return { rows: [] }
      const row: Record<string, unknown> = {
        id: values[0],
        service_request_id: values[1],
        buyer: values[2],
        task_id: values[3],
        seller_endpoint: values[4],
        provider_agent_id: values[5],
        endpoint_observation_id: values[6],
        endpoint_observed_at: values[7],
        seller_identity_chain_id: values[8],
        seller_registry: values[9],
        seller_agent_id: values[10],
        seller_owner: values[11],
        identity_observation_id: values[12],
        identity_block_number: values[13],
        identity_block_hash: values[14],
        identity_observed_at: values[15],
        task_description_sha256: values[16],
        quote_payload: JSON.parse(String(values[17])) as unknown,
        canonical_job_description: values[18],
        job_description_sha256: values[19],
        request_hash: values[20],
        response_hash: values[21],
        negotiation_hash: values[22],
        provider_signature: values[23],
        signature_method: values[24],
        signature_verification_basis: values[25],
        signature_verified_block_number: null,
        signature_verified_block_hash: null,
        verifier_version: values[26],
        signature_verified_at: values[27],
        chain_id: values[28],
        commerce: values[29],
        token: values[30],
        amount_units: values[31],
        token_decimals: values[32],
        negotiated_at: values[33],
        expires_at: values[34],
        idempotency_key: values[35],
        verified_at: values[36],
        created_at: values[36],
      }
      this.records.set(String(values[0]), row)
      return { rows: [row] }
    }
    if (text.startsWith("SELECT * FROM verified_quotes WHERE buyer")) {
      const row = [...this.records.values()].find((candidate) =>
        candidate.buyer === String(values[0]).toLowerCase() &&
        candidate.service_request_id === values[1] &&
        candidate.idempotency_key === values[2],
      )
      return { rows: row ? [row] : [] }
    }
    if (text.startsWith("SELECT * FROM verified_quotes WHERE id")) {
      const row = this.records.get(String(values[0]))
      return { rows: row?.buyer === String(values[1]).toLowerCase() ? [row] : [] }
    }
    throw new Error("unexpected verified quote repository query")
  }
}

const input = async (negotiatedAt = NOW) => {
  const signed = await signedQuote(negotiatedAt)
  return {
    id: quoteId,
    buyer,
    serviceRequestId,
    providerAgentId,
    endpointObservationId,
    identityObservationId,
    idempotencyKey: quoteId,
    requestedTerms,
    sentRequest: signed.sentRequest,
    quote: signed.quote,
  }
}

describe("VerifiedQuoteRepository funding fence", () => {
  it("persists and privately reads an independently verified EOA quote without enabling funding", async () => {
    const pool = new VerifiedQuotePool()
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    const value = await input()
    const created = await repository.create(value)
    const retried = await repository.create(value)
    const read = await repository.get(quoteId, buyer.toUpperCase())
    assert.equal(created.created, true)
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.deepEqual(read, created.record)
    assert.equal(created.record.fundingPermitted, false)
    assert.equal(created.record.signatureMethod, "eip191")
    assert.equal(created.record.verifierVersion, "knot.owned-seller-quote/2")
    assert.equal(created.record.identityObservationId, identityObservationId)
    assert.equal(created.record.identityBlockNumber, pool.context.identity_block_number)
    assert.equal(created.record.identityBlockHash, pool.context.identity_block_hash)
    assert.equal(created.record.sellerOwner, provider.address.toLowerCase())
    assert.equal(pool.records.size, 1)
  })

  it("returns an exact immutable retry after quote and task expiry without accepting a new write", async () => {
    const pool = new VerifiedQuotePool()
    pool.context.task_deadline_at = new Date((NOW + 1_800) * 1_000)
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    const value = await input()
    const created = await repository.create(value)
    const expiredRepository = new VerifiedQuoteRepository(
      pool as unknown as Pool,
      () => new Date((NOW + 2_000) * 1_000),
    )
    for (const status of ["INDEXED", "CALLABLE", "TASK_COMPATIBLE", "DISABLED"]) {
      pool.context.agent_status = status
      const retried = await expiredRepository.create(value)
      assert.equal(retried.created, false)
      assert.deepEqual(retried.record, created.record)
    }
    pool.context.agent_status = "HIREABLE"
    pool.context.identity_owner = `0x${"57".repeat(20)}`
    await assert.rejects(
      () => expiredRepository.create({ ...value, identityObservationId: "identity_quote_0002" }),
      IdempotencyConflictError,
    )
    await assert.rejects(
      () => expiredRepository.create({ ...value, id: "verified_quote_0002", idempotencyKey: "verified_quote_0002" }),
      /verified quote (?:context|task boundary) is unavailable/,
    )
    assert.equal(pool.records.size, 1)
  })

  it("rejects a conflicting quote under the same idempotency key", async () => {
    const pool = new VerifiedQuotePool()
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    await repository.create(await input())
    const conflicting = await input(NOW + 10)
    await assert.rejects(() => repository.create(conflicting), IdempotencyConflictError)
    assert.equal(pool.records.size, 1)
  })

  it("quarantines a stored record whose signature evidence changes", async () => {
    const pool = new VerifiedQuotePool()
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    await repository.create(await input())
    const row = pool.records.get(quoteId)
    assert.ok(row)
    row.provider_signature = `0x${"00".repeat(65)}`
    await assert.rejects(() => repository.get(quoteId, buyer), /stored verified quote failed integrity validation/)
  })

  it("refuses a quote when the retained identity observation is absent or mismatched", async () => {
    const pool = new VerifiedQuotePool()
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    const value = await input()
    await assert.rejects(
      () => repository.create({ ...value, identityObservationId: "identity_quote_missing" }),
      /verified quote context is unavailable/,
    )
    pool.context.identity_owner = `0x${"57".repeat(20)}`
    await assert.rejects(() => repository.create(value), /verified quote context is unavailable/)
    assert.equal(pool.records.size, 0)
  })

  it("requires the exact HIREABLE status for every new v2 quote", async () => {
    for (const status of ["INDEXED", "CALLABLE", "TASK_COMPATIBLE"]) {
      const pool = new VerifiedQuotePool()
      pool.context.agent_status = status
      const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
      await assert.rejects(async () => repository.create(await input()), /verified quote context is unavailable/)
      assert.equal(pool.records.size, 0)
    }
  })

  it("preserves integrity reads for historical verifier v1 rows without an observation foreign key", async () => {
    const pool = new VerifiedQuotePool()
    const repository = new VerifiedQuoteRepository(pool as unknown as Pool, () => now)
    await repository.create(await input())
    const row = pool.records.get(quoteId)
    assert.ok(row)
    row.verifier_version = "knot.owned-seller-quote/1"
    row.identity_observation_id = null
    const record = await repository.get(quoteId, buyer)
    assert.equal(record?.verifierVersion, "knot.owned-seller-quote/1")
    assert.equal(record?.identityObservationId, null)
  })
})
