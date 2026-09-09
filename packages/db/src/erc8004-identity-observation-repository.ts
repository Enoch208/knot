import { z } from "zod"

export interface IdentityObservationQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export type IdentityObservationChainId = 97

export interface RpcAgreementMetadata {
  schemaVersion: "knot.rpc-agreement/1"
  status: "AGREED"
  chainId: IdentityObservationChainId
  blockNumber: string
  blockHash: `0x${string}`
  minimumHeadBlockNumber: string
  requiredConfirmations: number
  providerCount: number
  agreementCount: number
  providerSetHash: `0x${string}`
}

export interface AppendErc8004IdentityObservationInput {
  id: string
  idempotencyKey: string
  agentRecordId: string
  chainId: IdentityObservationChainId
  registry: string
  agentId: string
  owner: string
  operatorRelation: string
  agentWallet: string | null
  tokenUri: string
  blockNumber: string
  blockHash: string
  confirmations: number
  proxyAddress: string
  proxyCodeHash: string
  implementationAddress: string
  implementationCodeHash: string
  rpcAgreement: RpcAgreementMetadata
  observedAt: Date
  status: "CONFIRMED"
}

export interface Erc8004IdentityObservationRecord {
  id: string
  idempotencyKey: string
  agentRecordId: string
  chainId: IdentityObservationChainId
  registry: `0x${string}`
  agentId: string
  owner: `0x${string}`
  operatorRelation: string
  agentWallet: `0x${string}` | null
  tokenUri: string
  blockNumber: string
  blockHash: `0x${string}`
  confirmations: number
  proxyAddress: `0x${string}`
  proxyCodeHash: `0x${string}`
  implementationAddress: `0x${string}`
  implementationCodeHash: `0x${string}`
  rpcAgreement: RpcAgreementMetadata
  observedAt: Date
  status: "CONFIRMED"
  createdAt: Date
}

export interface Erc8004IdentityObservationAppend {
  record: Erc8004IdentityObservationRecord
  created: boolean
}

export class Erc8004IdentityObservationConflictError extends Error {
  constructor() {
    super("ERC-8004 identity observation key is bound to different evidence")
    this.name = "Erc8004IdentityObservationConflictError"
  }
}

const observationRow = z.object({
  id: z.string(),
  idempotency_key: z.string(),
  agent_record_id: z.string(),
  chain_id: z.literal(97),
  registry: z.string(),
  agent_id: z.string(),
  owner: z.string(),
  operator_relation: z.string(),
  agent_wallet: z.string().nullable(),
  token_uri: z.string(),
  block_number: z.string(),
  block_hash: z.string(),
  confirmations: z.number(),
  proxy_address: z.string(),
  proxy_code_hash: z.string(),
  implementation_address: z.string(),
  implementation_code_hash: z.string(),
  rpc_agreement: z.unknown(),
  observed_at: z.date(),
  status: z.literal("CONFIRMED"),
  created_at: z.date(),
}).strict()

const rpcAgreementValue = z.object({
  schemaVersion: z.literal("knot.rpc-agreement/1"),
  status: z.literal("AGREED"),
  chainId: z.literal(97),
  blockNumber: z.string(),
  blockHash: z.string(),
  minimumHeadBlockNumber: z.string(),
  requiredConfirmations: z.number(),
  providerCount: z.number(),
  agreementCount: z.number(),
  providerSetHash: z.string(),
}).strict()

const agentRow = z.object({
  id: z.string(),
  chain_id: z.number(),
  registry: z.string(),
  agent_id: z.string(),
  owner_address: z.string(),
  operator_relation: z.string(),
}).strict()

type ObservationRow = z.infer<typeof observationRow>

const identifier = /^[A-Za-z0-9_-]{1,128}$/
const address = /^0x[0-9a-fA-F]{40}$/
const digest = /^0x[0-9a-fA-F]{64}$/
const uint256Maximum = (1n << 256n) - 1n
const isAddress = (value: string): value is `0x${string}` => address.test(value)
const isDigest = (value: string): value is `0x${string}` => digest.test(value)

const lowerAddress = (value: string): `0x${string}` => {
  const normalized = value.toLowerCase()
  if (!isAddress(normalized)) throw new RangeError("identity observation address is invalid")
  return normalized
}

const lowerDigest = (value: string): `0x${string}` => {
  const normalized = value.toLowerCase()
  if (!isDigest(normalized)) throw new RangeError("identity observation digest is invalid")
  return normalized
}

const normalizeUint256 = (value: string): string => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RangeError("identity observation integer is invalid")
  const parsed = BigInt(value)
  if (parsed > uint256Maximum) throw new RangeError("identity observation integer is invalid")
  return parsed.toString()
}

const databaseInteger = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647

const normalizeRpcAgreement = (
  value: unknown,
  chainId: IdentityObservationChainId,
  blockNumber: string,
  blockHash: `0x${string}`,
  confirmations: number,
): RpcAgreementMetadata => {
  const parsed = rpcAgreementValue.safeParse(value)
  if (!parsed.success) throw new RangeError("identity observation RPC agreement is invalid")
  const agreement = parsed.data
  const minimumHeadBlockNumber = normalizeUint256(agreement.minimumHeadBlockNumber)
  if (
    agreement.chainId !== chainId ||
    normalizeUint256(agreement.blockNumber) !== blockNumber ||
    !digest.test(agreement.blockHash) ||
    lowerDigest(agreement.blockHash) !== blockHash ||
    BigInt(minimumHeadBlockNumber) < BigInt(blockNumber) ||
    BigInt(minimumHeadBlockNumber) - BigInt(blockNumber) + 1n !== BigInt(confirmations) ||
    !databaseInteger(agreement.requiredConfirmations, 1) ||
    !databaseInteger(agreement.providerCount, 2) ||
    agreement.agreementCount !== agreement.providerCount ||
    !digest.test(agreement.providerSetHash) ||
    confirmations < agreement.requiredConfirmations
  ) {
    throw new RangeError("identity observation RPC agreement is invalid")
  }
  return {
    schemaVersion: "knot.rpc-agreement/1",
    status: "AGREED",
    chainId,
    blockNumber,
    blockHash,
    minimumHeadBlockNumber,
    requiredConfirmations: agreement.requiredConfirmations,
    providerCount: agreement.providerCount,
    agreementCount: agreement.agreementCount,
    providerSetHash: lowerDigest(agreement.providerSetHash),
  }
}

const normalizeInput = (
  input: AppendErc8004IdentityObservationInput,
  now: Date,
): AppendErc8004IdentityObservationInput => {
  const blockNumber = normalizeUint256(input.blockNumber)
  const agentId = normalizeUint256(input.agentId)
  if (
    !identifier.test(input.id) ||
    !identifier.test(input.idempotencyKey) ||
    !identifier.test(input.agentRecordId) ||
    input.chainId !== 97 ||
    !address.test(input.registry) ||
    !address.test(input.owner) ||
    (input.agentWallet !== null && !address.test(input.agentWallet)) ||
    typeof input.tokenUri !== "string" ||
    Buffer.byteLength(input.tokenUri, "utf8") < 1 ||
    Buffer.byteLength(input.tokenUri, "utf8") > 8192 ||
    !digest.test(input.blockHash) ||
    !databaseInteger(input.confirmations, 0) ||
    !address.test(input.proxyAddress) ||
    lowerAddress(input.proxyAddress) !== lowerAddress(input.registry) ||
    !digest.test(input.proxyCodeHash) ||
    !address.test(input.implementationAddress) ||
    !digest.test(input.implementationCodeHash) ||
    typeof input.operatorRelation !== "string" ||
    input.operatorRelation.length < 1 ||
    input.operatorRelation.length > 128 ||
    !(input.observedAt instanceof Date) ||
    !Number.isFinite(input.observedAt.getTime()) ||
    input.observedAt.getTime() > now.getTime() ||
    input.status !== "CONFIRMED"
  ) {
    throw new RangeError("ERC-8004 identity observation is invalid")
  }
  const registry = lowerAddress(input.registry)
  const blockHash = lowerDigest(input.blockHash)
  return {
    ...input,
    registry,
    agentId,
    owner: lowerAddress(input.owner),
    agentWallet: input.agentWallet === null ? null : lowerAddress(input.agentWallet),
    blockNumber,
    blockHash,
    proxyAddress: registry,
    proxyCodeHash: lowerDigest(input.proxyCodeHash),
    implementationAddress: lowerAddress(input.implementationAddress),
    implementationCodeHash: lowerDigest(input.implementationCodeHash),
    rpcAgreement: normalizeRpcAgreement(input.rpcAgreement, input.chainId, blockNumber, blockHash, input.confirmations),
  }
}

const mapRecord = (row: ObservationRow): Erc8004IdentityObservationRecord => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  agentRecordId: row.agent_record_id,
  chainId: row.chain_id,
  registry: lowerAddress(row.registry),
  agentId: row.agent_id,
  owner: lowerAddress(row.owner),
  operatorRelation: row.operator_relation,
  agentWallet: row.agent_wallet === null ? null : lowerAddress(row.agent_wallet),
  tokenUri: row.token_uri,
  blockNumber: row.block_number,
  blockHash: lowerDigest(row.block_hash),
  confirmations: row.confirmations,
  proxyAddress: lowerAddress(row.proxy_address),
  proxyCodeHash: lowerDigest(row.proxy_code_hash),
  implementationAddress: lowerAddress(row.implementation_address),
  implementationCodeHash: lowerDigest(row.implementation_code_hash),
  rpcAgreement: normalizeRpcAgreement(
    row.rpc_agreement,
    row.chain_id,
    normalizeUint256(row.block_number),
    lowerDigest(row.block_hash),
    row.confirmations,
  ),
  observedAt: row.observed_at,
  status: row.status,
  createdAt: row.created_at,
})

const sameRpcAgreement = (left: RpcAgreementMetadata, right: RpcAgreementMetadata): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.status === right.status &&
  left.chainId === right.chainId &&
  left.blockNumber === right.blockNumber &&
  left.blockHash === right.blockHash &&
  left.minimumHeadBlockNumber === right.minimumHeadBlockNumber &&
  left.requiredConfirmations === right.requiredConfirmations &&
  left.providerCount === right.providerCount &&
  left.agreementCount === right.agreementCount &&
  left.providerSetHash === right.providerSetHash

const same = (record: Erc8004IdentityObservationRecord, input: AppendErc8004IdentityObservationInput): boolean =>
  record.id === input.id &&
  record.idempotencyKey === input.idempotencyKey &&
  record.agentRecordId === input.agentRecordId &&
  record.chainId === input.chainId &&
  record.registry === input.registry &&
  record.agentId === input.agentId &&
  record.owner === input.owner &&
  record.operatorRelation === input.operatorRelation &&
  record.agentWallet === input.agentWallet &&
  record.tokenUri === input.tokenUri &&
  record.blockNumber === input.blockNumber &&
  record.blockHash === input.blockHash &&
  record.confirmations === input.confirmations &&
  record.proxyAddress === input.proxyAddress &&
  record.proxyCodeHash === input.proxyCodeHash &&
  record.implementationAddress === input.implementationAddress &&
  record.implementationCodeHash === input.implementationCodeHash &&
  sameRpcAgreement(record.rpcAgreement, input.rpcAgreement) &&
  record.observedAt.getTime() === input.observedAt.getTime() &&
  record.status === input.status

const assertStoredIntegrity = (record: Erc8004IdentityObservationRecord): void => {
  let normalized: AppendErc8004IdentityObservationInput
  try {
    normalized = normalizeInput(record, record.createdAt)
  } catch {
    throw new Error("stored ERC-8004 identity observation failed integrity validation")
  }
  if (!same(record, normalized)) {
    throw new Error("stored ERC-8004 identity observation failed integrity validation")
  }
}

export class Erc8004IdentityObservationRepository {
  private readonly database: IdentityObservationQueryExecutor
  private readonly now: () => Date

  constructor(database: IdentityObservationQueryExecutor, now: () => Date = () => new Date()) {
    this.database = database
    this.now = now
  }

  async append(input: AppendErc8004IdentityObservationInput): Promise<Erc8004IdentityObservationAppend> {
    const normalized = normalizeInput(input, this.now())
    const retry = await this.database.query(
      "SELECT * FROM erc8004_identity_observations WHERE idempotency_key = $1 OR id = $2",
      [normalized.idempotencyKey, normalized.id],
    )
    if (retry.rows.length > 0) {
      if (retry.rows.length !== 1) throw new Erc8004IdentityObservationConflictError()
      const record = this.readRow(retry.rows[0])
      if (!same(record, normalized)) throw new Erc8004IdentityObservationConflictError()
      return { record, created: false }
    }
    const bound = await this.database.query(
      "SELECT id, chain_id, registry, agent_id::text, owner_address, operator_relation FROM agents WHERE id = $1",
      [normalized.agentRecordId],
    )
    const agent = bound.rows[0] === undefined ? undefined : agentRow.parse(bound.rows[0])
    if (
      !agent ||
      agent.chain_id !== normalized.chainId ||
      agent.registry !== normalized.registry ||
      agent.agent_id !== normalized.agentId ||
      agent.owner_address !== normalized.owner ||
      agent.operator_relation !== normalized.operatorRelation
    ) {
      throw new Error("ERC-8004 identity observation agent binding is invalid")
    }
    const values = [
      normalized.id, normalized.idempotencyKey, normalized.agentRecordId, normalized.chainId, normalized.registry,
      normalized.agentId, normalized.owner, normalized.operatorRelation, normalized.agentWallet, normalized.tokenUri,
      normalized.blockNumber, normalized.blockHash, normalized.confirmations, normalized.proxyAddress,
      normalized.proxyCodeHash, normalized.implementationAddress, normalized.implementationCodeHash,
      JSON.stringify(normalized.rpcAgreement), normalized.observedAt, normalized.status,
    ]
    const inserted = await this.database.query(
      "INSERT INTO erc8004_identity_observations (id, idempotency_key, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, token_uri, block_number, block_hash, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, rpc_agreement, observed_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20) ON CONFLICT DO NOTHING RETURNING *",
      values,
    )
    if (inserted.rows[0]) return { record: this.readRow(inserted.rows[0]), created: true }
    const existing = await this.database.query(
      "SELECT * FROM erc8004_identity_observations WHERE idempotency_key = $1 OR id = $2 OR (chain_id = $3 AND registry = $4 AND agent_id = $5 AND block_number = $6 AND observed_at = $7)",
      [normalized.idempotencyKey, normalized.id, normalized.chainId, normalized.registry, normalized.agentId, normalized.blockNumber, normalized.observedAt],
    )
    if (existing.rows.length !== 1) throw new Erc8004IdentityObservationConflictError()
    const record = this.readRow(existing.rows[0])
    if (!same(record, normalized)) throw new Erc8004IdentityObservationConflictError()
    return { record, created: false }
  }

  async get(id: string): Promise<Erc8004IdentityObservationRecord | null> {
    if (!identifier.test(id)) throw new RangeError("identity observation identifier is invalid")
    const result = await this.database.query(
      "SELECT * FROM erc8004_identity_observations WHERE id = $1",
      [id],
    )
    return result.rows[0] ? this.readRow(result.rows[0]) : null
  }

  private readRow(row: unknown): Erc8004IdentityObservationRecord {
    try {
      const record = mapRecord(observationRow.parse(row))
      assertStoredIntegrity(record)
      return record
    } catch {
      throw new Error("stored ERC-8004 identity observation failed integrity validation")
    }
  }
}
