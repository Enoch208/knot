import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, it, test } from "node:test"
import {
  Erc8004IdentityObservationRepository,
  createDatabasePool,
  migrateDatabase,
  type AppendErc8004IdentityObservationInput,
} from "../../packages/db/src/index.ts"

const connectionString = process.env.KNOT_TEST_DATABASE_URL?.trim()

if (!connectionString) {
  test("ERC-8004 identity observation PostgreSQL persistence", { skip: "KNOT_TEST_DATABASE_URL is required" }, () => undefined)
}

const integration = connectionString ? describe : describe.skip

integration("ERC-8004 identity observation PostgreSQL persistence", () => {
  const pool = createDatabasePool(connectionString as string, { max: 2 })
  const repository = new Erc8004IdentityObservationRepository(pool, () => new Date("2026-09-09T20:00:00.000Z"))
  const agentRecordId = randomUUID()
  const secondAgentRecordId = randomUUID()
  const registry = "0x1212121212121212121212121212121212121212"
  const owner = "0x3434343434343434343434343434343434343434"
  const blockNumber = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()
  const secondAgentId = (BigInt(blockNumber) + 1n).toString()
  const secondOwner = "0x4545454545454545454545454545454545454545"
  const observationId = randomUUID()
  const input: AppendErc8004IdentityObservationInput = {
    id: observationId,
    idempotencyKey: observationId,
    agentRecordId,
    chainId: 97,
    registry,
    agentId: blockNumber,
    owner,
    operatorRelation: "KNOT_OPERATED",
    agentWallet: "0x5656565656565656565656565656565656565656",
    tokenUri: "ipfs://bafybeigdyrzt/identity.json",
    blockNumber,
    blockHash: `0x${"78".repeat(32)}`,
    confirmations: 18,
    proxyAddress: registry,
    proxyCodeHash: `0x${"9a".repeat(32)}`,
    implementationAddress: "0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
    implementationCodeHash: `0x${"de".repeat(32)}`,
    rpcAgreement: {
      schemaVersion: "knot.rpc-agreement/1",
      status: "AGREED",
      chainId: 97,
      blockNumber,
      blockHash: `0x${"78".repeat(32)}`,
      minimumHeadBlockNumber: (BigInt(blockNumber) + 17n).toString(),
      requiredConfirmations: 12,
      providerCount: 2,
      agreementCount: 2,
      providerSetHash: `0x${"f0".repeat(32)}`,
    },
    observedAt: new Date("2026-09-09T19:59:00.000Z"),
    status: "CONFIRMED",
  }

  before(async () => {
    await migrateDatabase(pool)
    await pool.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, $3, $4, $5, $6, 'HIREABLE')",
      [agentRecordId, registry, input.agentId, owner, input.operatorRelation, `0x${"11".repeat(32)}`],
    )
    await pool.query(
      "INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, $3, $4, $5, $6, 'HIREABLE')",
      [secondAgentRecordId, registry, secondAgentId, secondOwner, input.operatorRelation, `0x${"22".repeat(32)}`],
    )
  })

  it("persists one exact append and rejects database-level contradictions and mutation", async () => {
    const created = await repository.append(input)
    assert.equal(created.created, true)
    await assert.rejects(
      () => pool.query(
        "INSERT INTO erc8004_identity_observations (id, idempotency_key, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, token_uri, block_number, block_hash, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, rpc_agreement, observed_at, status, created_at) SELECT $2, $3, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, token_uri, block_number, $4, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, jsonb_set(rpc_agreement, '{blockHash}', to_jsonb($4::text)), observed_at + interval '1 second', status, created_at FROM erc8004_identity_observations WHERE id = $1",
        [observationId, randomUUID(), randomUUID(), `0x${"79".repeat(32)}`],
      ),
      /block contradiction/,
    )
    await assert.rejects(
      () => pool.query(
        "INSERT INTO erc8004_identity_observations (id, idempotency_key, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, token_uri, block_number, block_hash, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, rpc_agreement, observed_at, status, created_at) SELECT $2, $3, $4, chain_id, registry, $5, $6, operator_relation, agent_wallet, token_uri, block_number, block_hash, confirmations, proxy_address, $7, implementation_address, implementation_code_hash, rpc_agreement, observed_at + interval '1 second', status, created_at FROM erc8004_identity_observations WHERE id = $1",
        [observationId, randomUUID(), randomUUID(), secondAgentRecordId, secondAgentId, secondOwner, `0x${"9b".repeat(32)}`],
      ),
      /registry contradiction/,
    )
    await assert.rejects(
      () => pool.query(
        "INSERT INTO erc8004_identity_observations (id, idempotency_key, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, token_uri, block_number, block_hash, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, rpc_agreement, observed_at, status, created_at) SELECT $2, $3, agent_record_id, chain_id, registry, agent_id, owner, operator_relation, agent_wallet, $4, block_number, block_hash, confirmations, proxy_address, proxy_code_hash, implementation_address, implementation_code_hash, rpc_agreement, observed_at + interval '2 seconds', status, created_at FROM erc8004_identity_observations WHERE id = $1",
        [observationId, randomUUID(), randomUUID(), "ipfs://different"],
      ),
      /state contradiction/,
    )
    await assert.rejects(
      () => pool.query("UPDATE erc8004_identity_observations SET confirmations = confirmations WHERE id = $1", [observationId]),
      /append-only/,
    )
    await assert.rejects(
      () => pool.query("DELETE FROM erc8004_identity_observations WHERE id = $1", [observationId]),
      /append-only/,
    )
    await assert.rejects(
      () => pool.query("TRUNCATE erc8004_identity_observations"),
      /append-only|cannot truncate a table referenced in a foreign key constraint/,
    )
    const transactionId = randomUUID()
    const transactionBlockNumber = (BigInt(input.blockNumber) + 1n).toString()
    const transactionBlockHash = "0x8989898989898989898989898989898989898989898989898989898989898989"
    const transactionInput: AppendErc8004IdentityObservationInput = {
      ...input,
      id: transactionId,
      idempotencyKey: transactionId,
      blockNumber: transactionBlockNumber,
      blockHash: transactionBlockHash,
      rpcAgreement: {
        ...input.rpcAgreement,
        blockNumber: transactionBlockNumber,
        blockHash: transactionBlockHash,
        minimumHeadBlockNumber: (BigInt(transactionBlockNumber) + 17n).toString(),
      },
      observedAt: new Date(input.observedAt.getTime() + 1_000),
    }
    const transactionClient = await pool.connect()
    try {
      await transactionClient.query("BEGIN")
      const transactionRepository = new Erc8004IdentityObservationRepository(transactionClient)
      const transactionCreated = await transactionRepository.append(transactionInput)
      const transactionRetried = await transactionRepository.append(transactionInput)
      assert.equal(transactionCreated.created, true)
      assert.equal(transactionRetried.created, false)
      await transactionClient.query("ROLLBACK")
    } catch (error) {
      await transactionClient.query("ROLLBACK")
      throw error
    } finally {
      transactionClient.release()
    }
    assert.equal(await repository.get(transactionId), null)
    await pool.query("UPDATE agents SET owner_address = $2 WHERE id = $1", [agentRecordId, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const transactionRepository = new Erc8004IdentityObservationRepository(client)
      const retried = await transactionRepository.append(input)
      assert.equal(retried.created, false)
      assert.deepEqual(retried.record, created.record)
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  })

  after(async () => {
    await pool.end()
  })
})
