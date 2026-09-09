import {
  collectBscTestnetErc8004Identity,
  type Erc8004IdentityObservation,
} from "../../../packages/chain/src/erc8004-identity.ts"
import { createViemBscTestnetErc8004IdentityReaders } from "../../../packages/chain/src/erc8004-identity-viem.ts"
import {
  buildOwnedSellerNegotiationRequest,
  type OwnedSellerNegotiationRequest,
} from "../../../packages/contracts/src/owned-seller-negotiation.ts"
import type { ServiceRequestRecord, VerifiedQuoteCreation, VerifiedQuoteRecord } from "../../../packages/db/src/index.ts"
import {
  resolveOwnedSellerAuthority,
  type ExpectedPublicSeller,
} from "../../../packages/discovery/src/public-sellers.ts"
import {
  OwnedSellerClient,
  type OwnedSellerClientOptions,
  type OwnedSellerNegotiationResult,
} from "../../../packages/security/src/owned-seller-client.ts"
import type { OwnedSellerConfig } from "./owned-seller-config.ts"

type EnabledOwnedSellerConfig = Extract<OwnedSellerConfig, { enabled: true }>

export interface PersistVerifiedOwnedSellerQuoteInput {
  serviceRequest: ServiceRequestRecord
  seller: ExpectedPublicSeller
  identity: Erc8004IdentityObservation
  negotiationRequest: OwnedSellerNegotiationRequest
  negotiationResult: OwnedSellerNegotiationResult
}

export interface LockedVerifiedQuotePersistence {
  getExistingQuote(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteRecord | null>
  getServiceRequest(serviceRequestId: string, buyer: string): Promise<ServiceRequestRecord | null>
  persistVerifiedQuote(input: PersistVerifiedOwnedSellerQuoteInput): Promise<VerifiedQuoteCreation>
}

export interface VerifiedQuotePersistence {
  withServiceRequestLock<T>(
    buyer: string,
    serviceRequestId: string,
    operation: (locked: LockedVerifiedQuotePersistence) => Promise<T>,
  ): Promise<T>
}

export interface VerifiedQuoteOrchestratorOptions {
  collectIdentity?: (agentId: bigint) => Promise<Erc8004IdentityObservation>
  createClient?: (
    seller: ExpectedPublicSeller,
    credentials: EnabledOwnedSellerConfig["credentials"][ExpectedPublicSeller["key"]],
  ) => Pick<OwnedSellerClient, "negotiate">
  clientOptions?: OwnedSellerClientOptions
  now?: () => Date
  resolveSellerAuthority?: (
    category: ServiceRequestRecord["category"],
    endpoint: string,
  ) => ExpectedPublicSeller | null
}

export class VerifiedQuoteOrchestrationError extends Error {
  readonly code: "REQUEST_NOT_FOUND" | "REQUEST_EXPIRED" | "SELLER_AUTHORITY_MISMATCH" | "IDENTITY_MISMATCH"

  constructor(code: VerifiedQuoteOrchestrationError["code"], message: string) {
    super(message)
    this.name = "VerifiedQuoteOrchestrationError"
    this.code = code
  }
}

export class VerifiedQuoteOrchestrator {
  private readonly persistence: VerifiedQuotePersistence
  private readonly config: EnabledOwnedSellerConfig
  private readonly collectIdentity: (agentId: bigint) => Promise<Erc8004IdentityObservation>
  private readonly createClient: NonNullable<VerifiedQuoteOrchestratorOptions["createClient"]>
  private readonly now: () => Date
  private readonly resolveSellerAuthority: NonNullable<VerifiedQuoteOrchestratorOptions["resolveSellerAuthority"]>

  constructor(
    persistence: VerifiedQuotePersistence,
    config: EnabledOwnedSellerConfig,
    options: VerifiedQuoteOrchestratorOptions = {},
  ) {
    this.persistence = persistence
    this.config = config
    this.now = options.now ?? (() => new Date())
    this.resolveSellerAuthority = options.resolveSellerAuthority ?? resolveOwnedSellerAuthority
    this.collectIdentity = options.collectIdentity ?? (async (agentId) =>
      collectBscTestnetErc8004Identity(createViemBscTestnetErc8004IdentityReaders(), agentId, this.now))
    this.createClient = options.createClient ?? ((seller, credentials) => new OwnedSellerClient({
      key: seller.key,
      origin: seller.origin,
      tokenUrl: `${seller.origin}/oauth/token`,
      invocationUrl: `${seller.origin}/`,
      oauthScope: seller.oauthScope,
    }, credentials, options.clientOptions))
  }

  async create(serviceRequestId: string, buyer: string): Promise<VerifiedQuoteCreation> {
    return this.persistence.withServiceRequestLock(buyer, serviceRequestId, async (locked) => {
      const existing = await locked.getExistingQuote(serviceRequestId, buyer)
      if (existing !== null) return { record: existing, created: false }
      const serviceRequest = await locked.getServiceRequest(serviceRequestId, buyer)
      if (serviceRequest === null) {
        throw new VerifiedQuoteOrchestrationError("REQUEST_NOT_FOUND", "service request is unavailable")
      }
      if (new Date(serviceRequest.task.deadlineUtc).getTime() <= this.now().getTime()) {
        throw new VerifiedQuoteOrchestrationError("REQUEST_EXPIRED", "service request task deadline has elapsed")
      }
      const seller = this.resolveSellerAuthority(serviceRequest.category, serviceRequest.endpoint)
      if (seller === null) {
        throw new VerifiedQuoteOrchestrationError("SELLER_AUTHORITY_MISMATCH", "service request is not bound to an owned seller")
      }
      const identity = await this.collectIdentity(BigInt(seller.agentId))
      if (
        identity.agentId !== seller.agentId.toString() ||
        identity.chainId !== 97 ||
        identity.registry.toLowerCase() !== seller.registry.toLowerCase() ||
        identity.owner.toLowerCase() !== seller.owner ||
        identity.ownerAccountType !== "EOA"
      ) {
        throw new VerifiedQuoteOrchestrationError("IDENTITY_MISMATCH", "owned seller identity does not match its sealed authority")
      }
      const negotiationRequest = buildOwnedSellerNegotiationRequest({
        category: seller.category,
        serviceRequestId: serviceRequest.id,
        taskDescription: serviceRequest.taskDescription,
      })
      const negotiationResult = await this.createClient(seller, this.config.credentials[seller.key]).negotiate({
        requestId: serviceRequest.id,
        data: { ...negotiationRequest },
      })
      return locked.persistVerifiedQuote({
        serviceRequest,
        seller,
        identity,
        negotiationRequest,
        negotiationResult,
      })
    })
  }
}
