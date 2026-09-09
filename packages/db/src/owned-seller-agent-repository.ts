import { createHash } from "node:crypto"
import { z } from "zod"
import type { Erc8004IdentityObservation } from "../../chain/src/erc8004-identity.ts"
import { resolveTestnetSdkSource } from "../../commerce/src/deployments.ts"
import {
  expectedPublicSellers,
  type ExpectedPublicSeller,
} from "../../discovery/src/public-sellers.ts"
import type { IdentityObservationQueryExecutor } from "./erc8004-identity-observation-repository.ts"

export type OwnedSellerKey = "healthguard" | "rangepilot" | "gridquant" | "yieldscout"

export interface OwnedSellerAgentInput {
  sellerKey: OwnedSellerKey
  observation: Erc8004IdentityObservation
}

export interface OwnedSellerAgentRecord {
  id: string
  chainId: 97
  registry: string
  agentId: string
  owner: string
  operatorRelation: "KNOT_OPERATED"
  metadataHash: `0x${string}`
  status: "TASK_COMPATIBLE" | "HIREABLE"
  createdAt: Date
  updatedAt: Date
}

export interface OwnedSellerAgentBootstrap {
  record: OwnedSellerAgentRecord
  created: boolean
}

export interface OwnedSellerAgentPromotion {
  record: OwnedSellerAgentRecord
  promoted: boolean
}

export class OwnedSellerAgentConflictError extends Error {
  constructor() {
    super("owned seller agent identity conflicts with the sealed observation")
    this.name = "OwnedSellerAgentConflictError"
  }
}

interface PreparedOwnedSellerAgent {
  id: string
  chainId: 97
  registry: string
  agentId: string
  owner: string
  operatorRelation: "KNOT_OPERATED"
  metadataHash: `0x${string}`
}

const rowSchema = z.object({
  id: z.string(),
  chain_id: z.literal(97),
  registry: z.string(),
  agent_id: z.string(),
  owner_address: z.string(),
  operator_relation: z.string(),
  metadata_hash: z.string(),
  status: z.enum(["INDEXED", "CALLABLE", "TASK_COMPATIBLE", "HIREABLE", "EXECUTION_ENABLED", "DISABLED"]),
  created_at: z.date(),
  updated_at: z.date(),
}).strict()

const address = /^0x[0-9a-fA-F]{40}$/
const digest = /^0x[0-9a-fA-F]{64}$/
const maximumUint256 = (1n << 256n) - 1n
const zeroAddress = "0x0000000000000000000000000000000000000000"
const pinnedRegistry = resolveTestnetSdkSource("@bnbagent/sdk").deployment.registry.toLowerCase()
const isDigest = (value: string): value is `0x${string}` => digest.test(value)

const lowerDigest = (value: string): `0x${string}` => {
  const normalized = value.toLowerCase()
  if (!isDigest(normalized)) throw new Error("owned seller metadata hash is invalid")
  return normalized
}

const sha256 = (value: string): `0x${string}` => {
  const result = `0x${createHash("sha256").update(value, "utf8").digest("hex")}`
  if (!isDigest(result)) throw new Error("owned seller metadata hash is invalid")
  return result
}

const prepare = (
  input: OwnedSellerAgentInput,
  authorities: readonly ExpectedPublicSeller[],
): PreparedOwnedSellerAgent => {
  const observation = input.observation
  const seller = authorities.find((candidate) => candidate.key === input.sellerKey)
  if (
    seller === undefined ||
    seller.registry.toLowerCase() !== pinnedRegistry ||
    observation.schemaVersion !== "knot.erc8004-identity-observation/1" ||
    observation.status !== "VERIFIED" ||
    observation.chainId !== 97 ||
    observation.registry.toLowerCase() !== pinnedRegistry ||
    observation.agentId !== seller.agentId.toString() ||
    observation.owner.toLowerCase() !== seller.owner ||
    observation.ownerAccountType !== "EOA" ||
    !address.test(observation.owner) ||
    observation.owner.toLowerCase() === zeroAddress ||
    Buffer.byteLength(observation.tokenURI, "utf8") < 1 ||
    Buffer.byteLength(observation.tokenURI, "utf8") > 8_192 ||
    !/^(0|[1-9][0-9]*)$/.test(observation.agentId)
  ) {
    throw new RangeError("owned seller sealed identity is invalid")
  }
  const agentId = BigInt(observation.agentId)
  if (agentId > maximumUint256 || agentId.toString() !== observation.agentId) {
    throw new RangeError("owned seller sealed identity is invalid")
  }
  return {
    id: `owned_${input.sellerKey}_${observation.agentId}`,
    chainId: 97,
    registry: pinnedRegistry,
    agentId: observation.agentId,
    owner: observation.owner.toLowerCase(),
    operatorRelation: "KNOT_OPERATED",
    metadataHash: sha256(observation.tokenURI),
  }
}

const mapRow = (candidate: unknown) => {
  const row = rowSchema.parse(candidate)
  if (!address.test(row.registry) || !address.test(row.owner_address) || !isDigest(row.metadata_hash)) {
    throw new Error("stored owned seller agent failed integrity validation")
  }
  return {
    id: row.id,
    chainId: row.chain_id,
    registry: row.registry,
    agentId: row.agent_id,
    owner: row.owner_address,
    operatorRelation: row.operator_relation,
    metadataHash: lowerDigest(row.metadata_hash),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const exact = (record: ReturnType<typeof mapRow>, expected: PreparedOwnedSellerAgent): boolean =>
  record.id === expected.id &&
  record.chainId === expected.chainId &&
  record.registry === expected.registry &&
  record.agentId === expected.agentId &&
  record.owner === expected.owner &&
  record.operatorRelation === expected.operatorRelation &&
  record.metadataHash === expected.metadataHash

export class OwnedSellerAgentRepository {
  private readonly database: IdentityObservationQueryExecutor
  private readonly authorities: readonly ExpectedPublicSeller[]

  constructor(
    database: IdentityObservationQueryExecutor,
    authorities: readonly ExpectedPublicSeller[] = expectedPublicSellers,
  ) {
    this.database = database
    this.authorities = authorities
  }

  async bootstrap(input: OwnedSellerAgentInput): Promise<OwnedSellerAgentBootstrap> {
    const expected = prepare(input, this.authorities)
    const inserted = await this.database.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'TASK_COMPATIBLE') ON CONFLICT DO NOTHING RETURNING id, chain_id, registry, agent_id::text, owner_address, operator_relation, metadata_hash, status, created_at, updated_at",
      [expected.id, expected.chainId, expected.registry, expected.agentId, expected.owner, expected.operatorRelation, expected.metadataHash],
    )
    if (inserted.rows[0] !== undefined) return { record: this.readExact(inserted.rows[0], expected), created: true }
    const existing = await this.findConflicts(expected)
    if (existing.length !== 1) throw new OwnedSellerAgentConflictError()
    return { record: this.readExact(existing[0], expected), created: false }
  }

  async promoteHireable(input: OwnedSellerAgentInput): Promise<OwnedSellerAgentPromotion> {
    const expected = prepare(input, this.authorities)
    const updated = await this.database.query(
      "UPDATE agents SET status = 'HIREABLE', updated_at = now() WHERE id = $1 AND chain_id = $2 AND registry = $3 AND agent_id = $4 AND owner_address = $5 AND operator_relation = $6 AND metadata_hash = $7 AND status = 'TASK_COMPATIBLE' RETURNING id, chain_id, registry, agent_id::text, owner_address, operator_relation, metadata_hash, status, created_at, updated_at",
      [expected.id, expected.chainId, expected.registry, expected.agentId, expected.owner, expected.operatorRelation, expected.metadataHash],
    )
    if (updated.rows[0] !== undefined) return { record: this.readExact(updated.rows[0], expected), promoted: true }
    const existing = await this.findConflicts(expected)
    if (existing.length !== 1) throw new OwnedSellerAgentConflictError()
    const record = this.readExact(existing[0], expected)
    if (record.status !== "HIREABLE") throw new OwnedSellerAgentConflictError()
    return { record, promoted: false }
  }

  private async findConflicts(expected: PreparedOwnedSellerAgent): Promise<unknown[]> {
    const result = await this.database.query(
      "SELECT id, chain_id, registry, agent_id::text, owner_address, operator_relation, metadata_hash, status, created_at, updated_at FROM agents WHERE id = $1 OR (chain_id = $2 AND registry = $3 AND agent_id = $4)",
      [expected.id, expected.chainId, expected.registry, expected.agentId],
    )
    return result.rows
  }

  private readExact(candidate: unknown, expected: PreparedOwnedSellerAgent): OwnedSellerAgentRecord {
    let record: ReturnType<typeof mapRow>
    try {
      record = mapRow(candidate)
    } catch {
      throw new Error("stored owned seller agent failed integrity validation")
    }
    if (
      !exact(record, expected) ||
      record.operatorRelation !== "KNOT_OPERATED" ||
      (record.status !== "TASK_COMPATIBLE" && record.status !== "HIREABLE")
    ) throw new OwnedSellerAgentConflictError()
    return { ...record, operatorRelation: "KNOT_OPERATED", status: record.status }
  }
}
