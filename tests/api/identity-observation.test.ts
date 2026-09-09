import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { toPersistedIdentityObservation } from "../../apps/api/src/identity-observation.ts"
import type { Erc8004IdentityObservation } from "../../packages/chain/src/erc8004-identity.ts"

const observation: Erc8004IdentityObservation = {
  schemaVersion: "knot.erc8004-identity-observation/1",
  status: "VERIFIED",
  chainId: 97,
  registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  agentId: "2297",
  owner: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  ownerAccountType: "EOA",
  agentWallet: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  tokenURI: "data:application/json;base64,e30=",
  blockNumber: "130089514",
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

describe("identity observation persistence adapter", () => {
  it("maps the closed dual-RPC observation into append-only database evidence", () => {
    const value = toPersistedIdentityObservation({
      observation,
      agentRecordId: "rangepilot_2297",
      operatorRelation: "KNOT_OPERATED",
    })
    assert.equal(value.id, "erc8004_2297_130089514_1212121212121212")
    assert.equal(value.idempotencyKey, value.id)
    assert.equal(value.chainId, 97)
    assert.equal(value.blockNumber, observation.blockNumber)
    assert.equal(value.blockHash, observation.blockHash)
    assert.equal(value.confirmations, 4)
    assert.equal(value.rpcAgreement.minimumHeadBlockNumber, "130089517")
    assert.equal(value.rpcAgreement.requiredConfirmations, 3)
    assert.equal(value.rpcAgreement.providerCount, 2)
    assert.equal(value.rpcAgreement.agreementCount, 2)
    assert.match(value.rpcAgreement.providerSetHash, /^0x[0-9a-f]{64}$/)
    assert.equal(value.observedAt.toISOString(), observation.observedAtUtc)
  })

  it("derives the provider-set hash independent of reader order", () => {
    const left = toPersistedIdentityObservation({
      observation,
      agentRecordId: "rangepilot_2297",
      operatorRelation: "KNOT_OPERATED",
    })
    const right = toPersistedIdentityObservation({
      observation: { ...observation, rpcSources: [observation.rpcSources[1], observation.rpcSources[0]] },
      agentRecordId: "rangepilot_2297",
      operatorRelation: "KNOT_OPERATED",
    })
    assert.equal(left.rpcAgreement.providerSetHash, right.rpcAgreement.providerSetHash)
  })
})
