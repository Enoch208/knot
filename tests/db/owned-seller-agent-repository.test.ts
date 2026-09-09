import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import type { Erc8004IdentityObservation } from "../../packages/chain/src/erc8004-identity.ts"
import {
  OwnedSellerAgentConflictError,
  OwnedSellerAgentRepository,
  type OwnedSellerKey,
} from "../../packages/db/src/index.ts"

const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e"
const owners: Record<OwnedSellerKey, `0x${string}`> = {
  healthguard: "0xaf7474d06f171e6fd72fc5af114b34f3d5af8389",
  rangepilot: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  gridquant: "0x3d5355a97352f4d078016342ad117a5e88d5c74f",
  yieldscout: "0x6fd04720c7fccb6dcebf6cf08dd6f5c764c7d8e3",
}
const agentIds: Record<OwnedSellerKey, string> = {
  healthguard: "2295",
  rangepilot: "2297",
  gridquant: "2298",
  yieldscout: "2299",
}

const observation = (sellerKey: OwnedSellerKey): Erc8004IdentityObservation => ({
  schemaVersion: "knot.erc8004-identity-observation/1",
  status: "VERIFIED",
  chainId: 97,
  registry,
  agentId: agentIds[sellerKey],
  owner: owners[sellerKey],
  ownerAccountType: "EOA",
  agentWallet: owners[sellerKey],
  tokenURI: `data:application/json,{"name":"${sellerKey}"}`,
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
})

class AgentDatabase {
  readonly rows = new Map<string, Record<string, unknown>>()
  queryCount = 0

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.queryCount += 1
    if (text.startsWith("INSERT INTO agents")) {
      const conflict = [...this.rows.values()].some((row) =>
        row.id === values[0] ||
        (row.chain_id === values[1] && row.registry === values[2] && row.agent_id === values[3]))
      if (conflict) return { rows: [] }
      const timestamp = new Date("2026-09-09T20:00:00.000Z")
      const row = {
        id: values[0],
        chain_id: values[1],
        registry: values[2],
        agent_id: values[3],
        owner_address: values[4],
        operator_relation: values[5],
        metadata_hash: values[6],
        status: "TASK_COMPATIBLE",
        created_at: timestamp,
        updated_at: timestamp,
      }
      this.rows.set(String(values[0]), row)
      return { rows: [row] }
    }
    if (text.startsWith("UPDATE agents")) {
      const row = this.rows.get(String(values[0]))
      if (
        row === undefined ||
        row.chain_id !== values[1] ||
        row.registry !== values[2] ||
        row.agent_id !== values[3] ||
        row.owner_address !== values[4] ||
        row.operator_relation !== values[5] ||
        row.metadata_hash !== values[6] ||
        row.status !== "TASK_COMPATIBLE"
      ) return { rows: [] }
      row.status = "HIREABLE"
      row.updated_at = new Date("2026-09-09T20:01:00.000Z")
      return { rows: [row] }
    }
    if (text.startsWith("SELECT id, chain_id")) {
      return {
        rows: [...this.rows.values()].filter((row) =>
          row.id === values[0] ||
          (row.chain_id === values[1] && row.registry === values[2] && row.agent_id === values[3])),
      }
    }
    throw new Error("unexpected owned seller agent repository query")
  }
}

describe("OwnedSellerAgentRepository", () => {
  it("derives and bootstraps one task-compatible catalog row from sealed identity", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    const input = { sellerKey: "rangepilot" as const, observation: observation("rangepilot") }
    const created = await repository.bootstrap(input)
    const retried = await repository.bootstrap(input)
    const expectedMetadataHash = `0x${createHash("sha256").update(input.observation.tokenURI, "utf8").digest("hex")}`
    assert.equal(created.created, true)
    assert.equal(created.record.id, "owned_rangepilot_2297")
    assert.equal(created.record.status, "TASK_COMPATIBLE")
    assert.equal(created.record.metadataHash, expectedMetadataHash)
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.equal(database.rows.size, 1)
  })

  it("binds every seller key to its sealed public agent ID", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    await assert.rejects(
      () => repository.bootstrap({ sellerKey: "healthguard", observation: observation("rangepilot") }),
      RangeError,
    )
    assert.equal(database.queryCount, 0)
  })

  it("refuses a transferred owner before creating a KNOT-operated catalog row", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    await assert.rejects(
      () => repository.bootstrap({
        sellerKey: "rangepilot",
        observation: { ...observation("rangepilot"), owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
      RangeError,
    )
    assert.equal(database.queryCount, 0)
    assert.equal(database.rows.size, 0)
  })

  it("refuses owner, metadata, relation, and local-ID contradictions without overwriting", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    const input = { sellerKey: "rangepilot" as const, observation: observation("rangepilot") }
    const original = await repository.bootstrap(input)
    const row = database.rows.get(original.record.id)
    assert.ok(row)
    await assert.rejects(
      () => repository.bootstrap({
        ...input,
        observation: { ...input.observation, owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
      RangeError,
    )
    await assert.rejects(
      () => repository.bootstrap({
        ...input,
        observation: { ...input.observation, tokenURI: `${input.observation.tokenURI}x` },
      }),
      OwnedSellerAgentConflictError,
    )
    row.operator_relation = "EXTERNAL"
    await assert.rejects(() => repository.bootstrap(input), OwnedSellerAgentConflictError)
    row.operator_relation = "KNOT_OPERATED"
    row.id = "different_local_id"
    await assert.rejects(() => repository.bootstrap(input), OwnedSellerAgentConflictError)
    assert.equal(row.owner_address, owners.rangepilot)
    assert.equal(row.status, "TASK_COMPATIBLE")
  })

  it("promotes only an exact task-compatible row and preserves an exact hireable retry", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    const input = { sellerKey: "gridquant" as const, observation: observation("gridquant") }
    await repository.bootstrap(input)
    const promoted = await repository.promoteHireable(input)
    const retried = await repository.promoteHireable(input)
    const bootstrappedAgain = await repository.bootstrap(input)
    assert.equal(promoted.promoted, true)
    assert.equal(promoted.record.status, "HIREABLE")
    assert.equal(retried.promoted, false)
    assert.deepEqual(retried.record, promoted.record)
    assert.equal(bootstrappedAgain.created, false)
    assert.equal(bootstrappedAgain.record.status, "HIREABLE")
  })

  it("refuses promotion when absent, transferred, disabled, or not task-compatible", async () => {
    const database = new AgentDatabase()
    const repository = new OwnedSellerAgentRepository(database)
    const input = { sellerKey: "yieldscout" as const, observation: observation("yieldscout") }
    await assert.rejects(() => repository.promoteHireable(input), OwnedSellerAgentConflictError)
    const created = await repository.bootstrap(input)
    const row = database.rows.get(created.record.id)
    assert.ok(row)
    row.owner_address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    await assert.rejects(() => repository.promoteHireable(input), OwnedSellerAgentConflictError)
    row.owner_address = owners.yieldscout
    row.status = "DISABLED"
    await assert.rejects(() => repository.promoteHireable(input), OwnedSellerAgentConflictError)
    row.status = "CALLABLE"
    await assert.rejects(() => repository.promoteHireable(input), OwnedSellerAgentConflictError)
  })
})
