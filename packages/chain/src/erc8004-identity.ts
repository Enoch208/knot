import { getAddress, type Address, type Hash, type Hex } from "viem"
import { resolveTestnetSdkSource, TESTNET_CODE_SNAPSHOT } from "../../commerce/src/deployments.ts"
import { ERC1967_IMPLEMENTATION_SLOT, TESTNET } from "./manifest.ts"

const confirmationDepth = 3n
const maximumBlockAgeSeconds = 30
const maximumTokenUriBytes = 8_192
const zeroAddress = "0x0000000000000000000000000000000000000000"
const maximumUint256 = (1n << 256n) - 1n
const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
const registry = normalizedAddress(deployment.registry)
const implementation = normalizedAddress(deployment.registryImplementation)

export interface Erc8004IdentityBlock {
  number: bigint
  hash: Hash
  timestamp: bigint
}

export interface Erc8004IdentityReader {
  readonly sourceUri: string
  getChainId(): Promise<number>
  getHeadBlockNumber(): Promise<bigint>
  getBlock(blockNumber: bigint): Promise<Erc8004IdentityBlock>
  getCodeHash(address: Address, blockNumber: bigint): Promise<Hash | null>
  getStorageAt(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | null>
  ownerOf(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address>
  getAgentWallet(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<Address>
  tokenURI(registryAddress: Address, agentId: bigint, blockNumber: bigint): Promise<string>
}

export interface Erc8004IdentityObservation {
  schemaVersion: "knot.erc8004-identity-observation/1"
  status: "VERIFIED"
  chainId: 97
  registry: Address
  agentId: string
  owner: Address
  ownerAccountType: "EOA"
  agentWallet: Address
  tokenURI: string
  blockNumber: string
  blockHash: Hash
  blockTimestampUtc: string
  confirmationDepth: 3
  observedAtUtc: string
  registryDeployment: {
    proxyCodeHash: Hash
    implementation: Address
    implementationCodeHash: Hash
  }
  rpcSources: readonly [string, string]
  method: "eth_call@confirmed-block+block-hash-recheck+dual-rpc-agreement"
}

export type Erc8004IdentityErrorCode =
  | "CONFIGURATION_MISMATCH"
  | "DEPLOYMENT_MISMATCH"
  | "IDENTITY_MISMATCH"
  | "ORPHANED_OBSERVATION"
  | "RPC_DISAGREEMENT"
  | "STALE_BLOCK"
  | "UPSTREAM_UNAVAILABLE"

export class Erc8004IdentityError extends Error {
  readonly code: Erc8004IdentityErrorCode

  constructor(code: Erc8004IdentityErrorCode, message: string) {
    super(message)
    this.name = "Erc8004IdentityError"
    this.code = code
  }
}

export async function collectBscTestnetErc8004Identity(
  readers: readonly [Erc8004IdentityReader, Erc8004IdentityReader],
  agentId: bigint,
  now: () => Date = () => new Date(),
): Promise<Erc8004IdentityObservation> {
  try {
    return await collect(readers, agentId, now)
  } catch (error) {
    if (error instanceof Erc8004IdentityError) throw error
    throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "ERC-8004 identity reads did not complete")
  }
}

async function collect(
  suppliedReaders: readonly [Erc8004IdentityReader, Erc8004IdentityReader],
  agentId: bigint,
  now: () => Date,
): Promise<Erc8004IdentityObservation> {
  validateAgentId(agentId)
  const readers = orderedReaders(suppliedReaders)
  const chainIds = await parallelReaders(readers, (reader) => reader.getChainId())
  if (chainIds.some((chainId) => chainId !== 97)) {
    throw new Erc8004IdentityError("CONFIGURATION_MISMATCH", "Identity readers are not connected to BSC testnet")
  }
  const heads = await parallelReaders(readers, (reader) => reader.getHeadBlockNumber())
  const minimumHead = heads[0] < heads[1] ? heads[0] : heads[1]
  if (minimumHead < confirmationDepth) {
    throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "A confirmed BSC testnet block is unavailable")
  }
  const blockNumber = minimumHead - confirmationDepth
  const initialBlocks = await parallelReaders(readers, (reader) => reader.getBlock(blockNumber))
  validateBlockAgreement(initialBlocks, blockNumber)
  validateBlockAge(initialBlocks[0], now())
  const identities = await parallelReaders(readers, (reader) => readIdentity(reader, agentId, blockNumber))
  validateIdentityAgreement(identities)
  const finalBlocks = await parallelReaders(readers, (reader) => reader.getBlock(blockNumber))
  validateBlockAgreement(finalBlocks, blockNumber)
  if (
    normalizedHash(finalBlocks[0].hash) !== normalizedHash(initialBlocks[0].hash) ||
    normalizedHash(finalBlocks[1].hash) !== normalizedHash(initialBlocks[1].hash)
  ) {
    throw new Erc8004IdentityError("ORPHANED_OBSERVATION", "BSC testnet block hash changed during identity capture")
  }
  const observedAt = now()
  validateBlockAge(finalBlocks[0], observedAt)
  return {
    schemaVersion: "knot.erc8004-identity-observation/1",
    status: "VERIFIED",
    chainId: 97,
    registry,
    agentId: agentId.toString(),
    owner: identities[0].owner,
    ownerAccountType: "EOA",
    agentWallet: identities[0].agentWallet,
    tokenURI: identities[0].tokenURI,
    blockNumber: blockNumber.toString(),
    blockHash: normalizedHash(initialBlocks[0].hash),
    blockTimestampUtc: timestampIso(initialBlocks[0].timestamp),
    confirmationDepth: 3,
    observedAtUtc: observedAt.toISOString(),
    registryDeployment: {
      proxyCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registry,
      implementation,
      implementationCodeHash: TESTNET_CODE_SNAPSHOT.hashes.registryImplementation,
    },
    rpcSources: [readers[0].sourceUri, readers[1].sourceUri],
    method: "eth_call@confirmed-block+block-hash-recheck+dual-rpc-agreement",
  }
}

interface IdentityAtBlock {
  owner: Address
  agentWallet: Address
  tokenURI: string
}

async function readIdentity(reader: Erc8004IdentityReader, agentId: bigint, blockNumber: bigint): Promise<IdentityAtBlock> {
  const [proxyHash, implementationWord, ownerValue, walletValue, tokenURI] = await Promise.all([
    reader.getCodeHash(registry, blockNumber),
    reader.getStorageAt(registry, ERC1967_IMPLEMENTATION_SLOT, blockNumber),
    reader.ownerOf(registry, agentId, blockNumber),
    reader.getAgentWallet(registry, agentId, blockNumber),
    reader.tokenURI(registry, agentId, blockNumber),
  ])
  if (normalizedNullableHash(proxyHash) !== TESTNET_CODE_SNAPSHOT.hashes.registry) {
    throw new Erc8004IdentityError("DEPLOYMENT_MISMATCH", "ERC-8004 registry proxy code hash does not match the pin")
  }
  if (implementationFromWord(implementationWord) !== implementation) {
    throw new Erc8004IdentityError("DEPLOYMENT_MISMATCH", "ERC-8004 registry implementation slot does not match the pin")
  }
  const implementationHash = await reader.getCodeHash(implementation, blockNumber)
  if (normalizedNullableHash(implementationHash) !== TESTNET_CODE_SNAPSHOT.hashes.registryImplementation) {
    throw new Erc8004IdentityError("DEPLOYMENT_MISMATCH", "ERC-8004 registry implementation code hash does not match the pin")
  }
  const owner = normalizedAddress(ownerValue)
  const agentWallet = normalizedAddress(walletValue)
  if (owner === zeroAddress) throw new Erc8004IdentityError("IDENTITY_MISMATCH", "ERC-8004 owner is the zero address")
  if (await reader.getCodeHash(owner, blockNumber) !== null) {
    throw new Erc8004IdentityError("IDENTITY_MISMATCH", "ERC-8004 owner is not a direct EOA")
  }
  if (tokenURI.length === 0 || Buffer.byteLength(tokenURI, "utf8") > maximumTokenUriBytes) {
    throw new Erc8004IdentityError("IDENTITY_MISMATCH", "ERC-8004 token URI is absent or oversized")
  }
  return { owner, agentWallet, tokenURI }
}

function orderedReaders(readers: readonly [Erc8004IdentityReader, Erc8004IdentityReader]): readonly [Erc8004IdentityReader, Erc8004IdentityReader] {
  const expected = TESTNET.rpcUrls
  const ordered = expected.map((uri) => readers.find((reader) => reader.sourceUri === uri))
  if (expected.length !== 2 || ordered[0] === undefined || ordered[1] === undefined || ordered[0] === ordered[1]) {
    throw new Erc8004IdentityError("CONFIGURATION_MISMATCH", "Exactly two pinned BSC testnet RPC readers are required")
  }
  return [ordered[0], ordered[1]]
}

function validateBlockAgreement(
  blocks: readonly [Erc8004IdentityBlock, Erc8004IdentityBlock],
  expectedNumber: bigint,
): void {
  if (blocks.some((block) => block.number !== expectedNumber)) {
    throw new Erc8004IdentityError("RPC_DISAGREEMENT", "BSC testnet RPC returned the wrong block number")
  }
  const firstHash = normalizedHash(blocks[0].hash)
  if (normalizedHash(blocks[1].hash) !== firstHash || blocks[0].timestamp !== blocks[1].timestamp) {
    throw new Erc8004IdentityError("RPC_DISAGREEMENT", "BSC testnet RPCs disagree on the selected block")
  }
}

function validateIdentityAgreement(identities: readonly [IdentityAtBlock, IdentityAtBlock]): void {
  const first = identities[0]
  const second = identities[1]
  if (first.owner !== second.owner || first.agentWallet !== second.agentWallet || first.tokenURI !== second.tokenURI) {
    throw new Erc8004IdentityError("RPC_DISAGREEMENT", "BSC testnet RPCs disagree on ERC-8004 identity")
  }
}

function parallelReaders<T>(
  readers: readonly [Erc8004IdentityReader, Erc8004IdentityReader],
  operation: (reader: Erc8004IdentityReader) => Promise<T>,
): Promise<[T, T]> {
  return Promise.all([operation(readers[0]), operation(readers[1])])
}

function validateBlockAge(block: Erc8004IdentityBlock, now: Date): void {
  const currentSeconds = now.getTime() / 1_000
  const blockSeconds = Number(block.timestamp)
  if (!Number.isSafeInteger(blockSeconds) || !Number.isFinite(currentSeconds)) {
    throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "BSC testnet block timestamp is invalid")
  }
  const age = currentSeconds - blockSeconds
  if (age < -5) throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "BSC testnet block timestamp is in the future")
  if (age > maximumBlockAgeSeconds) throw new Erc8004IdentityError("STALE_BLOCK", "BSC testnet block is stale")
}

function validateAgentId(agentId: bigint): void {
  if (agentId < 0n || agentId > maximumUint256) {
    throw new Erc8004IdentityError("CONFIGURATION_MISMATCH", "ERC-8004 agent ID is outside uint256")
  }
}

function implementationFromWord(word: Hex | null): Address | null {
  if (word === null || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null
  const candidate = normalizedAddress(`0x${word.slice(-40)}`)
  return candidate === zeroAddress ? null : candidate
}

function normalizedAddress(value: string): Address {
  return getAddress(value).toLowerCase() as Address
}

function normalizedHash(value: string): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "BSC testnet RPC returned an invalid block hash")
  }
  return value.toLowerCase() as Hash
}

function normalizedNullableHash(value: string | null): Hash | null {
  return value === null ? null : normalizedHash(value)
}

function timestampIso(timestamp: bigint): string {
  const milliseconds = Number(timestamp) * 1_000
  const date = new Date(milliseconds)
  if (!Number.isSafeInteger(Number(timestamp)) || Number.isNaN(date.getTime())) {
    throw new Erc8004IdentityError("UPSTREAM_UNAVAILABLE", "BSC testnet block timestamp is invalid")
  }
  return date.toISOString()
}
