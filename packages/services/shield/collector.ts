import { keccak256, type Address, type Hash, type Hex } from "viem"
import { shieldRequest, type ShieldSnapshot } from "./schemas.ts"

export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const
export const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e0196a0a2e8ee1178d6a717850b5d6103" as const
export const ERC1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const

export interface ShieldBlock {
  number: bigint
  hash: Hash
  timestamp: bigint
}

export interface ShieldChainReader {
  readonly sourceUri: string
  getHeadBlockNumber(): Promise<bigint>
  getBlock(blockNumber: bigint): Promise<ShieldBlock>
  getBytecode(address: Address, blockNumber: bigint): Promise<Hex | null>
  getStorageAt(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | null>
}

export interface CollectShieldSnapshotOptions {
  targetAddress: Address
  confirmationBlocks?: bigint
  maxBlockAgeSeconds?: number
  now?: Date
  verifiedSource?: ShieldSnapshot["verifiedSource"]
}

export type ShieldCollectionErrorCode =
  | "INVALID_CONFIGURATION"
  | "ORPHANED_SNAPSHOT"
  | "STALE_SNAPSHOT"
  | "UPSTREAM_UNAVAILABLE"

export class ShieldCollectionError extends Error {
  readonly code: ShieldCollectionErrorCode

  constructor(code: ShieldCollectionErrorCode, message: string) {
    super(message)
    this.name = "ShieldCollectionError"
    this.code = code
  }
}

export async function collectShieldSnapshot(
  reader: ShieldChainReader,
  options: CollectShieldSnapshotOptions,
): Promise<ShieldSnapshot> {
  try {
    return await collect(reader, options)
  } catch (error) {
    if (error instanceof ShieldCollectionError) throw error
    throw new ShieldCollectionError("UPSTREAM_UNAVAILABLE", "Shield snapshot reads did not complete")
  }
}

async function collect(reader: ShieldChainReader, options: CollectShieldSnapshotOptions): Promise<ShieldSnapshot> {
  const now = options.now ?? new Date()
  const confirmations = options.confirmationBlocks ?? 5n
  if (confirmations < 0n) throw new ShieldCollectionError("INVALID_CONFIGURATION", "confirmation blocks cannot be negative")
  const maximumAge = options.maxBlockAgeSeconds ?? 60
  if (!Number.isFinite(maximumAge) || maximumAge <= 0) {
    throw new ShieldCollectionError("INVALID_CONFIGURATION", "maximum block age must be positive")
  }
  const head = await reader.getHeadBlockNumber()
  if (head < confirmations) throw new ShieldCollectionError("UPSTREAM_UNAVAILABLE", "a confirmed BSC block is unavailable")
  const blockNumber = head - confirmations
  const block = await reader.getBlock(blockNumber)
  validateBlock(block, blockNumber, now, maximumAge)
  const target = options.targetAddress.toLowerCase() as Address
  const [bytecode, implementation, admin, beacon] = await Promise.all([
    reader.getBytecode(target, blockNumber),
    readSlot(reader, target, ERC1967_IMPLEMENTATION_SLOT, blockNumber),
    readSlot(reader, target, ERC1967_ADMIN_SLOT, blockNumber),
    readSlot(reader, target, ERC1967_BEACON_SLOT, blockNumber),
  ])
  const verified = await reader.getBlock(blockNumber)
  if (verified.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new ShieldCollectionError("ORPHANED_SNAPSHOT", "BSC block hash changed during Shield capture")
  }
  const runtimeBytecode: ShieldSnapshot["runtimeBytecode"] = bytecode === null || bytecode === "0x"
    ? { status: "unavailable", reason: "no runtime bytecode exists at the target and pinned block" }
    : { status: "available", codeHash: keccak256(bytecode), sizeBytes: (bytecode.length - 2) / 2 }
  return shieldRequest.shape.snapshot.parse({
    schemaVersion: "knot.shield.snapshot/1",
    targetAddress: target,
    chainId: 56,
    blockNumber: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    blockTimestampUtc: new Date(Number(block.timestamp) * 1_000).toISOString(),
    capturedAtUtc: now.toISOString(),
    canonicality: "confirmed",
    runtimeBytecode,
    verifiedSource: options.verifiedSource ?? {
      status: "unavailable",
      reason: "no hash-bound verified source bundle was supplied for this capture",
    },
    proxySlots: { implementation, admin, beacon },
    observations: [],
  })
}

async function readSlot(
  reader: ShieldChainReader,
  target: Address,
  slot: Hex,
  blockNumber: bigint,
): Promise<ShieldSnapshot["proxySlots"]["admin"]> {
  let raw: Hex | null
  try {
    raw = await reader.getStorageAt(target, slot, blockNumber)
  } catch {
    return { status: "unreadable", value: null, rawValue: null, reason: "the pinned storage read failed" }
  }
  if (raw === null) return { status: "unreadable", value: null, rawValue: null, reason: "the pinned storage read returned no value" }
  const digits = raw.slice(2).toLowerCase()
  if (!/^[0-9a-f]*$/.test(digits) || digits.length > 64) {
    return { status: "unreadable", value: null, rawValue: null, reason: "the pinned storage read returned a malformed word" }
  }
  const word = digits.padStart(64, "0")
  const normalized = `0x${word}` as Hash
  if (/^0+$/.test(word)) return { status: "empty", value: null, rawValue: normalized }
  return { status: "value", value: `0x${word.slice(24)}` as Address, rawValue: normalized }
}

function validateBlock(block: ShieldBlock, requestedNumber: bigint, now: Date, maximumAgeSeconds: number): void {
  if (block.number !== requestedNumber) throw new ShieldCollectionError("UPSTREAM_UNAVAILABLE", "RPC returned a different block number")
  const age = now.getTime() / 1_000 - Number(block.timestamp)
  if (age < -5) throw new ShieldCollectionError("UPSTREAM_UNAVAILABLE", "BSC block timestamp is in the future")
  if (age > maximumAgeSeconds) throw new ShieldCollectionError("STALE_SNAPSHOT", "BSC block exceeds the maximum age")
}
