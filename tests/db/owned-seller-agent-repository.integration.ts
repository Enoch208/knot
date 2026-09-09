import assert from "node:assert/strict"
import { after, before, describe, it, test } from "node:test"
import type { Erc8004IdentityObservation } from "../../packages/chain/src/erc8004-identity.ts"
import {
  OwnedSellerAgentRepository,
  createDatabasePool,
  migrateDatabase,
} from "../../packages/db/src/index.ts"

const connectionString = process.env.KNOT_TEST_DATABASE_URL?.trim()

if (!connectionString) {
  test("owned seller agent PostgreSQL persistence", { skip: "KNOT_TEST_DATABASE_URL is required" }, () => undefined)
}

const integration = connectionString ? describe : describe.skip

integration("owned seller agent PostgreSQL persistence", () => {
  const pool = createDatabasePool(connectionString as string, { max: 2 })
  const repository = new OwnedSellerAgentRepository(pool)
  const observation: Erc8004IdentityObservation = {
    schemaVersion: "knot.erc8004-identity-observation/1",
    status: "VERIFIED",
    chainId: 97,
    registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
    agentId: "2298",
    owner: "0x3d5355a97352f4d078016342ad117a5e88d5c74f",
    ownerAccountType: "EOA",
    agentWallet: "0x3d5355a97352f4d078016342ad117a5e88d5c74f",
    tokenURI: "data:application/json,{\"name\":\"gridquant\"}",
    blockNumber: "130100000",
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
  }
  const input = { sellerKey: "gridquant" as const, observation }

  before(async () => {
    await migrateDatabase(pool)
  })

  it("rolls hireable promotion back with its caller-owned PoolClient transaction", async () => {
    const bootstrapped = await repository.bootstrap(input)
    assert.equal(bootstrapped.created, true)
    assert.equal(bootstrapped.record.status, "TASK_COMPATIBLE")
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const transactionRepository = new OwnedSellerAgentRepository(client)
      const promoted = await transactionRepository.promoteHireable(input)
      assert.equal(promoted.promoted, true)
      assert.equal(promoted.record.status, "HIREABLE")
      const inside = await client.query<{ status: string }>("SELECT status FROM agents WHERE id = $1", [promoted.record.id])
      assert.equal(inside.rows[0]?.status, "HIREABLE")
      await client.query("ROLLBACK")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    const outside = await pool.query<{ status: string }>("SELECT status FROM agents WHERE id = $1", [bootstrapped.record.id])
    assert.equal(outside.rows[0]?.status, "TASK_COMPATIBLE")
  })

  after(async () => {
    await pool.end()
  })
})
