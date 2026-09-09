import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  Erc8004IdentityObservationConflictError,
  Erc8004IdentityObservationRepository,
  type AppendErc8004IdentityObservationInput,
} from "../../packages/db/src/index.ts"

const now = new Date("2026-09-09T20:00:00.000Z")
const registry = "0x1212121212121212121212121212121212121212"
const owner = "0x3434343434343434343434343434343434343434"
const wallet = "0x5656565656565656565656565656565656565656"
const blockHash = `0x${"78".repeat(32)}` as `0x${string}`
const proxyCodeHash = `0x${"9a".repeat(32)}`
const implementation = "0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc"
const implementationCodeHash = `0x${"de".repeat(32)}`
const providerSetHash = `0x${"f0".repeat(32)}` as `0x${string}`

const input = (): AppendErc8004IdentityObservationInput => ({
  id: "identity_observation_2297_130100000",
  idempotencyKey: "identity_observation_2297_130100000",
  agentRecordId: "range_agent_2297",
  chainId: 97,
  registry,
  agentId: "2297",
  owner,
  operatorRelation: "KNOT_OPERATED",
  agentWallet: wallet,
  tokenUri: "ipfs://bafybeigdyrzt/2297.json",
  blockNumber: "130100000",
  blockHash,
  confirmations: 18,
  proxyAddress: registry,
  proxyCodeHash,
  implementationAddress: implementation,
  implementationCodeHash,
  rpcAgreement: {
    schemaVersion: "knot.rpc-agreement/1",
    status: "AGREED",
    chainId: 97,
    blockNumber: "130100000",
    blockHash,
    minimumHeadBlockNumber: "130100017",
    requiredConfirmations: 12,
    providerCount: 2,
    agreementCount: 2,
    providerSetHash,
  },
  observedAt: new Date("2026-09-09T19:59:00.000Z"),
  status: "CONFIRMED",
})

class IdentityObservationPool {
  readonly records = new Map<string, Record<string, unknown>>()
  agent = {
    id: "range_agent_2297",
    chain_id: 97,
    registry,
    agent_id: "2297",
    owner_address: owner,
    operator_relation: "KNOT_OPERATED",
  }
  queryCount = 0

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.queryCount += 1
    if (text.startsWith("SELECT * FROM erc8004_identity_observations WHERE idempotency_key") && !text.includes("chain_id = $3")) {
      const rows = [...this.records.values()].filter((row) => row.idempotency_key === values[0] || row.id === values[1])
      return { rows }
    }
    if (text.startsWith("SELECT id, chain_id")) {
      return { rows: this.agent.id === values[0] ? [this.agent] : [] }
    }
    if (text.startsWith("INSERT INTO erc8004_identity_observations")) {
      const naturalConflict = [...this.records.values()].some((row) =>
        row.chain_id === values[3] &&
        row.registry === values[4] &&
        row.agent_id === values[5] &&
        row.block_number === values[10] &&
        (row.observed_at as Date).getTime() === (values[18] as Date).getTime())
      const keyConflict = [...this.records.values()].some((row) =>
        row.id === values[0] || row.idempotency_key === values[1])
      if (naturalConflict || keyConflict) return { rows: [] }
      const row: Record<string, unknown> = {
        id: values[0],
        idempotency_key: values[1],
        agent_record_id: values[2],
        chain_id: values[3],
        registry: values[4],
        agent_id: values[5],
        owner: values[6],
        operator_relation: values[7],
        agent_wallet: values[8],
        token_uri: values[9],
        block_number: values[10],
        block_hash: values[11],
        confirmations: values[12],
        proxy_address: values[13],
        proxy_code_hash: values[14],
        implementation_address: values[15],
        implementation_code_hash: values[16],
        rpc_agreement: JSON.parse(String(values[17])) as unknown,
        observed_at: values[18],
        status: values[19],
        created_at: now,
      }
      this.records.set(String(values[0]), row)
      return { rows: [row] }
    }
    if (text.includes("chain_id = $3")) {
      const rows = [...this.records.values()].filter((row) =>
        row.idempotency_key === values[0] ||
        row.id === values[1] ||
        (row.chain_id === values[2] &&
          row.registry === values[3] &&
          row.agent_id === values[4] &&
          row.block_number === values[5] &&
          (row.observed_at as Date).getTime() === (values[6] as Date).getTime()))
      return { rows }
    }
    if (text === "SELECT * FROM erc8004_identity_observations WHERE id = $1") {
      const row = this.records.get(String(values[0]))
      return { rows: row ? [row] : [] }
    }
    throw new Error("unexpected identity observation repository query")
  }
}

describe("Erc8004IdentityObservationRepository", () => {
  it("appends one confirmed testnet observation and returns an exact retry after time and catalog changes", async () => {
    const pool = new IdentityObservationPool()
    const repository = new Erc8004IdentityObservationRepository(pool, () => now)
    const value = input()
    const created = await repository.append(value)
    pool.agent.owner_address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const later = new Erc8004IdentityObservationRepository(
      pool,
      () => new Date("2026-09-10T20:00:00.000Z"),
    )
    const retried = await later.append(value)
    assert.equal(created.created, true)
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.equal(created.record.chainId, 97)
    assert.equal(created.record.registry, registry)
    assert.equal(created.record.agentRecordId, pool.agent.id)
    assert.equal(created.record.operatorRelation, "KNOT_OPERATED")
    assert.equal(pool.records.size, 1)
  })

  it("rejects idempotency and same-observation contradictions", async () => {
    const pool = new IdentityObservationPool()
    const repository = new Erc8004IdentityObservationRepository(pool, () => now)
    const value = input()
    await repository.append(value)
    await assert.rejects(
      () => repository.append({ ...value, tokenUri: "ipfs://different" }),
      Erc8004IdentityObservationConflictError,
    )
    await assert.rejects(
      () => repository.append({
        ...value,
        id: "identity_observation_2297_conflict",
        idempotencyKey: "identity_observation_2297_conflict",
        tokenUri: "ipfs://different",
      }),
      Erc8004IdentityObservationConflictError,
    )
    assert.equal(pool.records.size, 1)
  })

  it("requires an exact current local-agent binding for a new observation", async () => {
    const pool = new IdentityObservationPool()
    const repository = new Erc8004IdentityObservationRepository(pool, () => now)
    await assert.rejects(
      () => repository.append({ ...input(), owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      /agent binding is invalid/,
    )
    await assert.rejects(
      () => repository.append({ ...input(), operatorRelation: "EXTERNAL" }),
      /agent binding is invalid/,
    )
    assert.equal(pool.records.size, 0)
  })

  it("fails before persistence on malformed or insufficiently corroborated observations", async () => {
    const invalid = [
      { ...input(), chainId: 56 },
      { ...input(), tokenUri: "" },
      { ...input(), proxyAddress: owner },
      { ...input(), implementationCodeHash: "0x01" },
      { ...input(), confirmations: 11 },
      { ...input(), observedAt: new Date("2026-09-09T20:00:01.000Z") },
      { ...input(), rpcAgreement: { ...input().rpcAgreement, providerCount: 1, agreementCount: 1 } },
      { ...input(), rpcAgreement: { ...input().rpcAgreement, blockHash: `0x${"12".repeat(32)}` } },
      { ...input(), rpcAgreement: { ...input().rpcAgreement, minimumHeadBlockNumber: "130100018" } },
    ]
    for (const value of invalid) {
      const pool = new IdentityObservationPool()
      const repository = new Erc8004IdentityObservationRepository(pool, () => now)
      await assert.rejects(
        () => repository.append(value as AppendErc8004IdentityObservationInput),
        RangeError,
      )
      assert.equal(pool.queryCount, 0)
    }
  })

  it("quarantines a malformed stored RPC agreement on read", async () => {
    const pool = new IdentityObservationPool()
    const repository = new Erc8004IdentityObservationRepository(pool, () => now)
    const value = input()
    await repository.append(value)
    const row = pool.records.get(value.id)
    assert.ok(row)
    row.rpc_agreement = { ...(row.rpc_agreement as Record<string, unknown>), status: "DISAGREED" }
    await assert.rejects(
      () => repository.get(value.id),
      /stored ERC-8004 identity observation failed integrity validation/,
    )
  })
})
