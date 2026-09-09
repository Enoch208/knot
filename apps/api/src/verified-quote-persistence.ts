import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import {
  EndpointObservationRepository,
  Erc8004IdentityObservationRepository,
  OwnedSellerAgentRepository,
  ServiceRequestRepository,
  VerifiedQuoteRepository,
  type ServiceRequestRecord,
  type VerifiedQuoteRecord,
} from "../../../packages/db/src/index.ts"
import {
  resolveOwnedSellerAuthority,
  type ExpectedPublicSeller,
} from "../../../packages/discovery/src/public-sellers.ts"
import { toPersistedIdentityObservation } from "./identity-observation.ts"
import type {
  LockedVerifiedQuotePersistence,
  PersistVerifiedOwnedSellerQuoteInput,
  VerifiedQuotePersistence,
} from "./verified-quote-orchestrator.ts"

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

const sameServiceRequest = (left: ServiceRequestRecord, right: ServiceRequestRecord): boolean =>
  left.id === right.id &&
  left.buyer === right.buyer &&
  left.endpoint === right.endpoint &&
  left.taskId === right.taskId &&
  left.category === right.category &&
  left.taskDescription === right.taskDescription &&
  left.taskDescriptionSha256 === right.taskDescriptionSha256 &&
  left.requestSha256 === right.requestSha256 &&
  left.requestBytes.equals(right.requestBytes)

export class PgVerifiedQuotePersistence implements VerifiedQuotePersistence {
  private readonly pool: Pool
  private readonly now: () => Date
  private readonly resolveSellerAuthority: (
    category: ServiceRequestRecord["category"],
    endpoint: string,
  ) => ExpectedPublicSeller | null

  constructor(
    pool: Pool,
    now: () => Date = () => new Date(),
    resolveSellerAuthority: (
      category: ServiceRequestRecord["category"],
      endpoint: string,
    ) => ExpectedPublicSeller | null = resolveOwnedSellerAuthority,
  ) {
    this.pool = pool
    this.now = now
    this.resolveSellerAuthority = resolveSellerAuthority
  }

  async withServiceRequestLock<T>(
    buyer: string,
    serviceRequestId: string,
    operation: (locked: LockedVerifiedQuotePersistence) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    const lockKey = `${buyer.toLowerCase()}:${serviceRequestId}`
    let locked = false
    let discardClient = false
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey])
      locked = true
      return await operation(new LockedPgVerifiedQuotePersistence(client, this.now, this.resolveSellerAuthority))
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        } catch {
          discardClient = true
        }
      }
      client.release(discardClient)
    }
  }
}

class LockedPgVerifiedQuotePersistence implements LockedVerifiedQuotePersistence {
  private readonly client: PoolClient
  private readonly now: () => Date
  private readonly resolveSellerAuthority: (
    category: ServiceRequestRecord["category"],
    endpoint: string,
  ) => ExpectedPublicSeller | null

  constructor(
    client: PoolClient,
    now: () => Date,
    resolveSellerAuthority: (
      category: ServiceRequestRecord["category"],
      endpoint: string,
    ) => ExpectedPublicSeller | null,
  ) {
    this.client = client
    this.now = now
    this.resolveSellerAuthority = resolveSellerAuthority
  }

  getExistingQuote(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteRecord | null> {
    return new VerifiedQuoteRepository(this.client, this.now).get(serviceRequestId, buyer)
  }

  getServiceRequest(serviceRequestId: string, buyer: string): Promise<ServiceRequestRecord | null> {
    return new ServiceRequestRepository(this.client, this.now).get(serviceRequestId, buyer)
  }

  async persistVerifiedQuote(input: PersistVerifiedOwnedSellerQuoteInput) {
    await this.client.query("BEGIN")
    try {
      const current = await new ServiceRequestRepository(this.client, this.now).get(
        input.serviceRequest.id,
        input.serviceRequest.buyer,
      )
      const seller = current === null ? null : this.resolveSellerAuthority(current.category, current.endpoint)
      if (
        current === null ||
        !sameServiceRequest(current, input.serviceRequest) ||
        seller === null ||
        seller.key !== input.seller.key ||
        seller.agentId !== input.seller.agentId ||
        seller.category !== input.seller.category ||
        seller.cardName !== input.seller.cardName ||
        seller.registry.toLowerCase() !== input.seller.registry.toLowerCase() ||
        seller.owner !== input.seller.owner ||
        seller.origin !== input.seller.origin ||
        seller.oauthScope !== input.seller.oauthScope
      ) {
        throw new Error("verified quote service request changed before persistence")
      }
      const verifiedAt = this.now()
      const identityObservedAt = new Date(input.identity.observedAtUtc)
      if (
        !Number.isFinite(identityObservedAt.getTime()) ||
        identityObservedAt.getTime() > verifiedAt.getTime() ||
        verifiedAt.getTime() - identityObservedAt.getTime() > 60_000
      ) {
        throw new Error("verified quote identity observation is no longer current")
      }
      const agents = new OwnedSellerAgentRepository(this.client, [seller])
      await agents.bootstrap({ sellerKey: seller.key, observation: input.identity })
      const promoted = await agents.promoteHireable({ sellerKey: seller.key, observation: input.identity })
      const identityObservation = await new Erc8004IdentityObservationRepository(this.client, this.now).append(
        toPersistedIdentityObservation({
          observation: input.identity,
          agentRecordId: promoted.record.id,
          operatorRelation: "KNOT_OPERATED",
        }),
      )
      const endpointObservedAt = this.now()
      const endpointObservationId = `endpoint_${sha256(`${current.buyer}:${current.id}`).slice(0, 32)}`
      const endpointObservation = await new EndpointObservationRepository(this.client).appendNegotiationSuccess({
        id: endpointObservationId,
        agentRecordId: promoted.record.id,
        endpoint: `${seller.origin}/`,
        latencyMilliseconds: input.negotiationResult.metrics.oauthLatencyMilliseconds + input.negotiationResult.metrics.invocationLatencyMilliseconds,
        safeDetails: {
          schemaVersion: "knot.owned-seller-endpoint-observation/1",
          sellerKey: seller.key,
          transportVersion: "knot.owned-seller-client/1",
          httpStatus: 200,
          responseByteLength: input.negotiationResult.metrics.responseByteLength,
          responseSha256: input.negotiationResult.metrics.responseSha256,
        },
        observedAt: endpointObservedAt,
      })
      const quote = await new VerifiedQuoteRepository(this.client, this.now).create({
        id: current.id,
        buyer: current.buyer,
        serviceRequestId: current.id,
        providerAgentId: promoted.record.id,
        endpointObservationId: endpointObservation.record.id,
        identityObservationId: identityObservation.record.id,
        idempotencyKey: current.id,
        requestedTerms: input.negotiationRequest.request.terms,
        sentRequest: input.negotiationRequest.request,
        quote: input.negotiationResult.payload,
      })
      await this.client.query("COMMIT")
      return quote
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  }
}
