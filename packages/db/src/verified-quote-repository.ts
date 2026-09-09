import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { recoverMessageAddress, type Hex } from "viem"
import { resolveTestnetSdkSource } from "../../commerce/src/deployments.ts"
import {
  recheckOwnedSellerQuoteIntegrity,
  verifyOwnedSellerQuote,
  type OwnedSellerNegotiationQuote,
  type OwnedSellerRequestedTerms,
} from "../../contracts/src/service-quote.ts"
import { taskSpec, type TaskSpec } from "../../contracts/src/task.ts"
import { IdempotencyConflictError } from "./errors.ts"

interface QuoteContextRow {
  service_request_id: string
  buyer: string
  seller_endpoint: string
  task_id: string
  task_description: string
  task_description_sha256: `0x${string}`
  task_spec: unknown
  task_deadline_at: Date
  provider_agent_id: string
  seller_identity_chain_id: number
  seller_registry: string
  seller_agent_id: string
  seller_owner: string
  operator_relation: string
  agent_status: string
  identity_observation_id: string
  identity_agent_record_id: string
  identity_chain_id: number
  identity_registry: string
  identity_agent_id: string
  identity_owner: string
  identity_operator_relation: string
  identity_block_number: string
  identity_block_hash: `0x${string}`
  identity_observed_at: Date
  identity_status: string
  endpoint_observation_id: string
  endpoint_request_type: string
  endpoint_result: string
  endpoint_observed_at: Date
}

interface VerifiedQuoteRow {
  id: string
  service_request_id: string
  buyer: string
  task_id: string
  seller_endpoint: string
  provider_agent_id: string
  endpoint_observation_id: string
  endpoint_observed_at: Date
  seller_identity_chain_id: 97
  seller_registry: string
  seller_agent_id: string
  seller_owner: string
  identity_observation_id: string | null
  identity_block_number: string
  identity_block_hash: `0x${string}`
  identity_observed_at: Date
  task_description_sha256: `0x${string}`
  quote_payload: OwnedSellerNegotiationQuote
  canonical_job_description: string
  job_description_sha256: `0x${string}`
  request_hash: `0x${string}`
  response_hash: `0x${string}`
  negotiation_hash: `0x${string}`
  provider_signature: `0x${string}`
  signature_method: "eip191"
  signature_verification_basis: "eip191_recovered"
  signature_verified_block_number: null
  signature_verified_block_hash: null
  verifier_version: "knot.owned-seller-quote/1" | "knot.owned-seller-quote/2"
  signature_verified_at: Date
  chain_id: 97
  commerce: string
  token: string
  amount_units: string
  token_decimals: number
  negotiated_at: string
  expires_at: string
  idempotency_key: string
  verified_at: Date
  created_at: Date
}

export interface CreateVerifiedQuoteInput {
  id: string
  buyer: string
  serviceRequestId: string
  providerAgentId: string
  endpointObservationId: string
  identityObservationId: string
  idempotencyKey: string
  requestedTerms: OwnedSellerRequestedTerms
  sentRequest: unknown
  quote: unknown
}

export interface VerifiedQuoteRecord {
  id: string
  serviceRequestId: string
  buyer: `0x${string}`
  taskId: string
  sellerEndpoint: string
  providerAgentId: string
  endpointObservationId: string
  endpointObservedAt: Date
  sellerIdentityChainId: 97
  sellerRegistry: `0x${string}`
  sellerAgentId: string
  sellerOwner: `0x${string}`
  identityObservationId: string | null
  identityBlockNumber: string
  identityBlockHash: `0x${string}`
  identityObservedAt: Date
  taskDescriptionSha256: `0x${string}`
  quote: OwnedSellerNegotiationQuote
  canonicalJobDescription: string
  jobDescriptionSha256: `0x${string}`
  requestHash: `0x${string}`
  responseHash: `0x${string}`
  negotiationHash: `0x${string}`
  providerSignature: `0x${string}`
  signatureMethod: "eip191"
  signatureVerificationBasis: "eip191_recovered"
  verifierVersion: "knot.owned-seller-quote/1" | "knot.owned-seller-quote/2"
  signatureVerifiedAt: Date
  chainId: 97
  commerce: `0x${string}`
  token: `0x${string}`
  amountUnits: string
  tokenDecimals: number
  negotiatedAtUnix: string
  expiresAtUnix: string
  idempotencyKey: string
  verifiedAt: Date
  createdAt: Date
  fundingPermitted: false
}

export interface VerifiedQuoteCreation {
  record: VerifiedQuoteRecord
  created: boolean
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/
const address = /^0x[0-9a-fA-F]{40}$/

const lowerAddress = (value: string): `0x${string}` => value.toLowerCase() as `0x${string}`
const sha256 = (value: string): `0x${string}` =>
  `0x${createHash("sha256").update(value, "utf8").digest("hex")}`

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("value is not JSON serializable")
  return encoded
}

const mapRecord = (row: VerifiedQuoteRow): VerifiedQuoteRecord => ({
  id: row.id,
  serviceRequestId: row.service_request_id,
  buyer: row.buyer as `0x${string}`,
  taskId: row.task_id,
  sellerEndpoint: row.seller_endpoint,
  providerAgentId: row.provider_agent_id,
  endpointObservationId: row.endpoint_observation_id,
  endpointObservedAt: row.endpoint_observed_at,
  sellerIdentityChainId: row.seller_identity_chain_id,
  sellerRegistry: row.seller_registry as `0x${string}`,
  sellerAgentId: row.seller_agent_id,
  sellerOwner: row.seller_owner as `0x${string}`,
  identityObservationId: row.identity_observation_id,
  identityBlockNumber: row.identity_block_number,
  identityBlockHash: row.identity_block_hash,
  identityObservedAt: row.identity_observed_at,
  taskDescriptionSha256: row.task_description_sha256,
  quote: row.quote_payload,
  canonicalJobDescription: row.canonical_job_description,
  jobDescriptionSha256: row.job_description_sha256,
  requestHash: row.request_hash,
  responseHash: row.response_hash,
  negotiationHash: row.negotiation_hash,
  providerSignature: row.provider_signature,
  signatureMethod: row.signature_method,
  signatureVerificationBasis: row.signature_verification_basis,
  verifierVersion: row.verifier_version,
  signatureVerifiedAt: row.signature_verified_at,
  chainId: row.chain_id,
  commerce: row.commerce as `0x${string}`,
  token: row.token as `0x${string}`,
  amountUnits: row.amount_units,
  tokenDecimals: row.token_decimals,
  negotiatedAtUnix: row.negotiated_at,
  expiresAtUnix: row.expires_at,
  idempotencyKey: row.idempotency_key,
  verifiedAt: row.verified_at,
  createdAt: row.created_at,
  fundingPermitted: false,
})

const assertRecordIntegrity = async (record: VerifiedQuoteRecord): Promise<void> => {
  const checked = recheckOwnedSellerQuoteIntegrity(record.quote)
  let recovered: string
  try {
    recovered = await recoverMessageAddress({
      message: record.negotiationHash,
      signature: record.providerSignature as Hex,
    })
  } catch {
    throw new Error("stored verified quote failed integrity validation")
  }
  if (
    checked.canonicalJobDescription !== record.canonicalJobDescription ||
    sha256(record.canonicalJobDescription) !== record.jobDescriptionSha256 ||
    checked.requestHash !== record.requestHash ||
    checked.responseHash !== record.responseHash ||
    checked.negotiationHash !== record.negotiationHash ||
    checked.quote.provider_sig.toLowerCase() !== record.providerSignature ||
    checked.quote.response.terms.price !== record.amountUnits ||
    lowerAddress(checked.quote.response.terms.currency) !== record.token ||
    lowerAddress(checked.quote.verifying_contract) !== record.commerce ||
    checked.quote.chain_id !== record.chainId ||
    checked.quote.response.negotiated_at.toString() !== record.negotiatedAtUnix ||
    checked.quote.response.quote_expires_at.toString() !== record.expiresAtUnix ||
    sha256(checked.quote.request.task_description) !== record.taskDescriptionSha256 ||
    record.signatureMethod !== "eip191" ||
    record.signatureVerificationBasis !== "eip191_recovered" ||
    !(
      record.verifierVersion === "knot.owned-seller-quote/1" && record.identityObservationId === null ||
      record.verifierVersion === "knot.owned-seller-quote/2" &&
        record.identityObservationId !== null &&
        identifier.test(record.identityObservationId)
    ) ||
    lowerAddress(recovered) !== record.sellerOwner
  ) {
    throw new Error("stored verified quote failed integrity validation")
  }
}

const loadTask = (value: unknown): TaskSpec => {
  const parsed = taskSpec.safeParse(value)
  if (!parsed.success) throw new Error("verified quote task context failed integrity validation")
  return parsed.data
}

const assertExactReplay = async (
  record: VerifiedQuoteRecord,
  input: CreateVerifiedQuoteInput,
): Promise<void> => {
  let replay: OwnedSellerNegotiationQuote
  try {
    const verified = await verifyOwnedSellerQuote({
      sentRequest: input.sentRequest,
      quote: input.quote,
      expected: {
        provider: record.sellerOwner,
        providerKind: "eoa",
        chainId: record.chainId,
        verifyingContract: record.commerce,
        currency: record.token,
        maxPriceUnits: record.amountUnits,
        taskDescription: record.quote.request.task_description,
        terms: input.requestedTerms,
        requestId: record.serviceRequestId,
      },
      nowUnix: Math.floor(record.verifiedAt.getTime() / 1_000),
    })
    if (verified.status !== "VERIFIED_EOA") throw new IdempotencyConflictError()
    replay = verified.quote
  } catch {
    throw new IdempotencyConflictError()
  }
  if (
    record.id !== input.id ||
    record.buyer !== input.buyer.toLowerCase() ||
    record.serviceRequestId !== input.serviceRequestId ||
    record.providerAgentId !== input.providerAgentId ||
    record.endpointObservationId !== input.endpointObservationId ||
    record.identityObservationId !== input.identityObservationId ||
    record.idempotencyKey !== input.idempotencyKey ||
    canonicalJson(record.quote) !== canonicalJson(replay)
  ) {
    throw new IdempotencyConflictError()
  }
}

export class VerifiedQuoteRepository {
  private readonly pool: Pick<Pool, "query">
  private readonly now: () => Date

  constructor(pool: Pool | PoolClient, now: () => Date = () => new Date()) {
    this.pool = pool
    this.now = now
  }

  async create(input: CreateVerifiedQuoteInput): Promise<VerifiedQuoteCreation> {
    if (
      !identifier.test(input.id) ||
      !identifier.test(input.serviceRequestId) ||
      !identifier.test(input.providerAgentId) ||
      !identifier.test(input.endpointObservationId) ||
      !identifier.test(input.identityObservationId) ||
      !identifier.test(input.idempotencyKey) ||
      !address.test(input.buyer)
    ) {
      throw new RangeError("verified quote identifiers are invalid")
    }
    const verifiedAt = this.now()
    const existingBeforeContext = await this.pool.query<VerifiedQuoteRow>(
      "SELECT * FROM verified_quotes WHERE buyer = lower($1) AND service_request_id = $2 AND idempotency_key = $3",
      [input.buyer, input.serviceRequestId, input.idempotencyKey],
    )
    if (existingBeforeContext.rows[0]) {
      const record = mapRecord(existingBeforeContext.rows[0])
      await assertRecordIntegrity(record)
      await assertExactReplay(record, input)
      return { record, created: false }
    }
    const contextResult = await this.pool.query<QuoteContextRow>(
      "SELECT sr.id AS service_request_id, sr.buyer, sr.endpoint AS seller_endpoint, sr.task_id, sr.task_description, sr.task_description_sha256, t.task_spec, t.deadline_at AS task_deadline_at, a.id AS provider_agent_id, a.chain_id AS seller_identity_chain_id, a.registry AS seller_registry, a.agent_id::text AS seller_agent_id, a.owner_address AS seller_owner, a.operator_relation, a.status AS agent_status, io.id AS identity_observation_id, io.agent_record_id AS identity_agent_record_id, io.chain_id AS identity_chain_id, io.registry AS identity_registry, io.agent_id::text AS identity_agent_id, io.owner AS identity_owner, io.operator_relation AS identity_operator_relation, io.block_number::text AS identity_block_number, io.block_hash AS identity_block_hash, io.observed_at AS identity_observed_at, io.status AS identity_status, eo.id AS endpoint_observation_id, eo.request_type AS endpoint_request_type, eo.result AS endpoint_result, eo.observed_at AS endpoint_observed_at FROM service_requests sr JOIN tasks t ON t.id = sr.task_id AND t.buyer = sr.buyer JOIN agents a ON a.id = $3 JOIN endpoint_observations eo ON eo.id = $4 AND eo.agent_id = a.id JOIN erc8004_identity_observations io ON io.id = $5 AND io.agent_record_id = a.id WHERE sr.id = $1 AND sr.buyer = lower($2)",
      [input.serviceRequestId, input.buyer, input.providerAgentId, input.endpointObservationId, input.identityObservationId],
    )
    const context = contextResult.rows[0]
    if (
      !context ||
      context.operator_relation !== "KNOT_OPERATED" ||
      context.agent_status !== "HIREABLE" ||
      context.endpoint_request_type !== "negotiate" ||
      context.endpoint_result !== "SUCCESS" ||
      context.endpoint_observed_at.getTime() > verifiedAt.getTime() ||
      context.seller_identity_chain_id !== 97 ||
      context.identity_status !== "CONFIRMED" ||
      context.identity_observed_at.getTime() > verifiedAt.getTime() ||
      context.identity_agent_record_id !== context.provider_agent_id ||
      context.identity_chain_id !== context.seller_identity_chain_id ||
      context.identity_registry !== context.seller_registry ||
      context.identity_agent_id !== context.seller_agent_id ||
      context.identity_owner !== context.seller_owner ||
      context.identity_operator_relation !== context.operator_relation
    ) {
      throw new Error("verified quote context is unavailable")
    }
    const task = loadTask(context.task_spec)
    if (
      task.paymentChainId !== 97 ||
      task.identityChainId !== 97 ||
      task.executionChainId !== null ||
      task.serviceFeeLimit.chainId !== 97
    ) {
      throw new Error("verified quote task boundary is unavailable")
    }
    const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
    const expected = {
      provider: context.seller_owner,
      providerKind: "eoa" as const,
      chainId: 97 as const,
      verifyingContract: deployment.commerce,
      currency: task.serviceFeeLimit.token,
      maxPriceUnits: task.serviceFeeLimit.units,
      taskDescription: context.task_description,
      terms: input.requestedTerms,
      requestId: input.serviceRequestId,
    }
    if (context.task_deadline_at.getTime() <= verifiedAt.getTime()) {
      throw new Error("verified quote task boundary is unavailable")
    }
    const verified = await verifyOwnedSellerQuote({
      sentRequest: input.sentRequest,
      quote: input.quote,
      expected,
      nowUnix: Math.floor(verifiedAt.getTime() / 1_000),
    })
    if (verified.status !== "VERIFIED_EOA") throw new Error("verified quote signature requires a network verifier")
    if (verified.quoteExpiresAtUnix * 1_000 > context.task_deadline_at.getTime()) {
      throw new Error("verified quote expires after the task deadline")
    }
    if (lowerAddress(verified.currency) !== lowerAddress(deployment.paymentToken)) {
      throw new Error("verified quote token does not match the pinned commerce deployment")
    }
    const jobDescriptionSha256 = sha256(verified.canonicalJobDescription)
    const values = [
      input.id,
      context.service_request_id,
      context.buyer,
      context.task_id,
      context.seller_endpoint,
      context.provider_agent_id,
      context.endpoint_observation_id,
      context.endpoint_observed_at,
      context.seller_identity_chain_id,
      context.seller_registry,
      context.seller_agent_id,
      context.seller_owner,
      context.identity_observation_id,
      context.identity_block_number,
      context.identity_block_hash,
      context.identity_observed_at,
      context.task_description_sha256,
      JSON.stringify(verified.quote),
      verified.canonicalJobDescription,
      jobDescriptionSha256,
      verified.requestHash,
      verified.responseHash,
      verified.negotiationHash,
      verified.providerSignature.toLowerCase(),
      verified.signatureMethod,
      "eip191_recovered",
      "knot.owned-seller-quote/2",
      verifiedAt,
      verified.chainId,
      lowerAddress(verified.verifyingContract),
      lowerAddress(verified.currency),
      verified.priceUnits,
      task.serviceFeeLimit.decimals,
      verified.negotiatedAtUnix.toString(),
      verified.quoteExpiresAtUnix.toString(),
      input.idempotencyKey,
      verifiedAt,
    ]
    const inserted = await this.pool.query<VerifiedQuoteRow>(
      "INSERT INTO verified_quotes (id, service_request_id, buyer, task_id, seller_endpoint, provider_agent_id, endpoint_observation_id, endpoint_observed_at, seller_identity_chain_id, seller_registry, seller_agent_id, seller_owner, identity_observation_id, identity_block_number, identity_block_hash, identity_observed_at, task_description_sha256, quote_payload, canonical_job_description, job_description_sha256, request_hash, response_hash, negotiation_hash, provider_signature, signature_method, signature_verification_basis, verifier_version, signature_verified_at, chain_id, commerce, token, amount_units, token_decimals, negotiated_at, expires_at, idempotency_key, verified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT observed_at FROM endpoint_observations WHERE id = $7), $8::timestamptz), $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37) ON CONFLICT DO NOTHING RETURNING *",
      values,
    )
    if (inserted.rows[0]) {
      const record = mapRecord(inserted.rows[0])
      await assertRecordIntegrity(record)
      return { record, created: true }
    }
    const existing = await this.pool.query<VerifiedQuoteRow>(
      "SELECT * FROM verified_quotes WHERE buyer = lower($1) AND service_request_id = $2 AND idempotency_key = $3",
      [input.buyer, input.serviceRequestId, input.idempotencyKey],
    )
    const row = existing.rows[0]
    if (!row) throw new IdempotencyConflictError()
    const record = mapRecord(row)
    await assertRecordIntegrity(record)
    await assertExactReplay(record, input)
    return { record, created: false }
  }

  async get(id: string, buyer: string): Promise<VerifiedQuoteRecord | null> {
    const result = await this.pool.query<VerifiedQuoteRow>(
      "SELECT * FROM verified_quotes WHERE id = $1 AND buyer = lower($2)",
      [id, buyer],
    )
    const row = result.rows[0]
    if (!row) return null
    const record = mapRecord(row)
    await assertRecordIntegrity(record)
    return record
  }
}
