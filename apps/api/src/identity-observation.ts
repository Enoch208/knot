import { createHash } from "node:crypto"
import type { Erc8004IdentityObservation } from "../../../packages/chain/src/erc8004-identity.ts"
import type { AppendErc8004IdentityObservationInput } from "../../../packages/db/src/index.ts"

const sha256 = (value: string): `0x${string}` =>
  `0x${createHash("sha256").update(value, "utf8").digest("hex")}`

export const toPersistedIdentityObservation = (input: {
  observation: Erc8004IdentityObservation
  agentRecordId: string
  operatorRelation: "KNOT_OPERATED"
}): AppendErc8004IdentityObservationInput => {
  const blockNumber = BigInt(input.observation.blockNumber)
  const minimumHeadBlockNumber = blockNumber + BigInt(input.observation.confirmationDepth)
  const confirmations = Number(minimumHeadBlockNumber - blockNumber + 1n)
  const id = `erc8004_${input.observation.agentId}_${input.observation.blockNumber}_${input.observation.blockHash.slice(2, 18)}`
  return {
    id,
    idempotencyKey: id,
    agentRecordId: input.agentRecordId,
    chainId: 97,
    registry: input.observation.registry,
    agentId: input.observation.agentId,
    owner: input.observation.owner,
    operatorRelation: input.operatorRelation,
    agentWallet: input.observation.agentWallet,
    tokenUri: input.observation.tokenURI,
    blockNumber: input.observation.blockNumber,
    blockHash: input.observation.blockHash,
    confirmations,
    proxyAddress: input.observation.registry,
    proxyCodeHash: input.observation.registryDeployment.proxyCodeHash,
    implementationAddress: input.observation.registryDeployment.implementation,
    implementationCodeHash: input.observation.registryDeployment.implementationCodeHash,
    rpcAgreement: {
      schemaVersion: "knot.rpc-agreement/1",
      status: "AGREED",
      chainId: 97,
      blockNumber: input.observation.blockNumber,
      blockHash: input.observation.blockHash,
      minimumHeadBlockNumber: minimumHeadBlockNumber.toString(),
      requiredConfirmations: input.observation.confirmationDepth,
      providerCount: input.observation.rpcSources.length,
      agreementCount: input.observation.rpcSources.length,
      providerSetHash: sha256(JSON.stringify([...input.observation.rpcSources].sort())),
    },
    observedAt: new Date(input.observation.observedAtUtc),
    status: "CONFIRMED",
  }
}
