import { keccak256, stringToHex, type Address, type Hash } from "viem"

export interface VenusBlock {
  number: bigint
  hash: Hash
  timestamp: bigint
}

export interface VenusMarketIdentity {
  vTokenSymbol: string
  comptroller: Address
  underlying: Address | null
  underlyingSymbol: string
  underlyingDecimals: number
}

export interface VenusMarketConfiguration {
  isListed: boolean
  collateralFactorMantissa: bigint
  liquidationThresholdMantissa: bigint
  marketPoolId: bigint
  isBorrowAllowed: boolean
}

export interface VenusMarketPosition {
  collateralUnits: bigint
  debtUnits: bigint
}

export interface VenusCoreReader {
  readonly sourceUri: string
  getHeadBlockNumber(): Promise<bigint>
  getBlock(blockNumber: bigint): Promise<VenusBlock>
  getAllMarkets(comptroller: Address, blockNumber: bigint): Promise<readonly Address[]>
  getAssetsIn(comptroller: Address, borrower: Address, blockNumber: bigint): Promise<readonly Address[]>
  getOracle(comptroller: Address, blockNumber: bigint): Promise<Address>
  getProtocolPaused(comptroller: Address, blockNumber: bigint): Promise<boolean>
  getMintedVai(comptroller: Address, borrower: Address, blockNumber: bigint): Promise<bigint>
  getMarketPosition(vToken: Address, borrower: Address, blockNumber: bigint): Promise<VenusMarketPosition>
  getMarketIdentity(vToken: Address, native: boolean, blockNumber: bigint): Promise<VenusMarketIdentity>
  getMarketConfiguration(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<VenusMarketConfiguration>
  getUnderlyingPrice(oracle: Address, vToken: Address, blockNumber: bigint): Promise<bigint | null>
  getRepayPaused(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<boolean>
  getForcedLiquidation(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<boolean>
}

export interface SupportedVenusCoreMarket {
  vToken: Address
  vTokenSymbol: string
  asset: Address
  symbol: string
  decimals: number
  native: boolean
}

export interface VenusHealthSnapshot {
  schemaVersion: "knot.health.snapshot/1"
  snapshotId: string
  chainId: 56
  blockNumber: string
  blockHash: Hash
  blockTimestampUtc: string
  capturedAtUtc: string
  canonicality: "confirmed"
  sources: Array<{ uri: string; contentHash: Hash; method: string }>
  borrower: Address
  comptroller: Address
  poolFamily: "venus-core"
  debtInventoryComplete: boolean
  protocolStatus: "active" | "paused"
  forcedLiquidation: "enabled" | "paused"
  actionAvailable: boolean
  markets: VenusHealthMarket[]
  specialDebts: Array<{ kind: string; valueUsdE18: string | null; supported: boolean }>
}

export interface VenusHealthMarket {
  asset: Address
  symbol: string
  decimals: number
  collateralUnits: string
  debtUnits: string
  oraclePriceUsdE18: string | null
  collateralFactorBps: number
  liquidationThresholdBps: number
  collateralEnabled: boolean
  oracleStatus: "current" | "unavailable"
  priceObservedAtUtc: string | null
  supported: boolean
}

export type VenusSnapshotErrorCode =
  | "CONFIGURATION_MISMATCH"
  | "ORPHANED_SNAPSHOT"
  | "STALE_SNAPSHOT"
  | "UNSUPPORTED_POSITION"
  | "UPSTREAM_UNAVAILABLE"

export class VenusSnapshotError extends Error {
  readonly code: VenusSnapshotErrorCode

  constructor(code: VenusSnapshotErrorCode, message: string) {
    super(message)
    this.name = "VenusSnapshotError"
    this.code = code
  }
}

export interface CollectVenusCoreSnapshotOptions {
  borrower: Address
  comptroller: Address
  supportedMarkets: readonly SupportedVenusCoreMarket[]
  confirmationBlocks?: bigint
  maxBlockAgeSeconds?: number
  now?: Date
  readConcurrency?: number
}

interface PositionedMarket {
  vToken: Address
  position: VenusMarketPosition
}

export async function collectVenusCoreSnapshot(
  reader: VenusCoreReader,
  options: CollectVenusCoreSnapshotOptions,
): Promise<VenusHealthSnapshot> {
  try {
    return await collect(reader, options)
  } catch (error) {
    if (error instanceof VenusSnapshotError) throw error
    throw new VenusSnapshotError("UPSTREAM_UNAVAILABLE", "Venus Core snapshot reads did not complete")
  }
}

async function collect(reader: VenusCoreReader, options: CollectVenusCoreSnapshotOptions): Promise<VenusHealthSnapshot> {
  const now = options.now ?? new Date()
  const confirmations = options.confirmationBlocks ?? 3n
  const head = await reader.getHeadBlockNumber()
  if (confirmations < 0n || head < confirmations) {
    throw new VenusSnapshotError("UPSTREAM_UNAVAILABLE", "A confirmed Venus Core block is unavailable")
  }
  const blockNumber = head - confirmations
  const block = await reader.getBlock(blockNumber)
  validateBlockAge(block, now, options.maxBlockAgeSeconds ?? 30)
  const comptroller = normalized(options.comptroller)
  const borrower = normalized(options.borrower)
  const [inventory, entered, oracle, protocolPaused, mintedVai] = await Promise.all([
    reader.getAllMarkets(comptroller, blockNumber),
    reader.getAssetsIn(comptroller, borrower, blockNumber),
    reader.getOracle(comptroller, blockNumber),
    reader.getProtocolPaused(comptroller, blockNumber),
    reader.getMintedVai(comptroller, borrower, blockNumber),
  ])
  const uniqueInventory = uniqueAddresses(inventory)
  if (uniqueInventory.length !== inventory.length) {
    throw new VenusSnapshotError("CONFIGURATION_MISMATCH", "Venus Core returned duplicate markets")
  }
  const concurrency = options.readConcurrency ?? 8
  const positioned = await mapConcurrent(uniqueInventory, concurrency, async (vToken): Promise<PositionedMarket> => ({
    vToken,
    position: await reader.getMarketPosition(vToken, borrower, blockNumber),
  }))
  const active = positioned.filter(({ position }) => position.collateralUnits > 0n || position.debtUnits > 0n)
  const supported = supportedByVToken(options.supportedMarkets)
  const unsupported = active.find(({ vToken }) => !supported.has(vToken))
  if (unsupported) {
    throw new VenusSnapshotError("UNSUPPORTED_POSITION", `Position uses unsupported Venus Core market ${unsupported.vToken}`)
  }
  const enteredSet = new Set(uniqueAddresses(entered))
  const blockTime = new Date(Number(block.timestamp) * 1_000).toISOString()
  const marketResults = await mapConcurrent(active, concurrency, async ({ vToken, position }) => {
    const expected = supported.get(vToken)
    if (!expected) throw new VenusSnapshotError("UNSUPPORTED_POSITION", `Unsupported Venus Core market ${vToken}`)
    const [identity, configuration, rawPrice, repayPaused, forced] = await Promise.all([
      reader.getMarketIdentity(vToken, expected.native, blockNumber),
      reader.getMarketConfiguration(comptroller, vToken, blockNumber),
      reader.getUnderlyingPrice(normalized(oracle), vToken, blockNumber),
      reader.getRepayPaused(comptroller, vToken, blockNumber),
      reader.getForcedLiquidation(comptroller, vToken, blockNumber),
    ])
    validateIdentity(expected, identity, comptroller)
    const configurationSupported = configuration.isListed && configuration.marketPoolId === 0n
    const price = rawPrice === null || rawPrice <= 0n ? null : oraclePriceE18(rawPrice, expected.decimals)
    const market: VenusHealthMarket = {
      asset: normalized(expected.asset),
      symbol: expected.symbol,
      decimals: expected.decimals,
      collateralUnits: position.collateralUnits.toString(),
      debtUnits: position.debtUnits.toString(),
      oraclePriceUsdE18: price?.toString() ?? null,
      collateralFactorBps: mantissaToBps(configuration.collateralFactorMantissa),
      liquidationThresholdBps: mantissaToBps(configuration.liquidationThresholdMantissa),
      collateralEnabled: enteredSet.has(vToken),
      oracleStatus: price === null ? "unavailable" : "current",
      priceObservedAtUtc: price === null ? null : blockTime,
      supported: configurationSupported && price !== null,
    }
    return { market, repayPaused, forced, debt: position.debtUnits }
  })
  const verified = await reader.getBlock(blockNumber)
  if (verified.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new VenusSnapshotError("ORPHANED_SNAPSHOT", "Venus Core block hash changed during capture")
  }
  const reference = `${block.hash.toLowerCase()}:${borrower}:${comptroller}`
  const contentHash = keccak256(stringToHex(`${reader.sourceUri}:${block.number}:${reference}`))
  return {
    schemaVersion: "knot.health.snapshot/1",
    snapshotId: keccak256(stringToHex(reference)),
    chainId: 56,
    blockNumber: block.number.toString(),
    blockHash: normalizedHash(block.hash),
    blockTimestampUtc: blockTime,
    capturedAtUtc: now.toISOString(),
    canonicality: "confirmed",
    sources: [{ uri: reader.sourceUri, contentHash, method: "eth_call@blockNumber+hash-verification" }],
    borrower,
    comptroller,
    poolFamily: "venus-core",
    debtInventoryComplete: true,
    protocolStatus: protocolPaused ? "paused" : "active",
    forcedLiquidation: marketResults.some(({ forced }) => forced) ? "enabled" : "paused",
    actionAvailable: !protocolPaused && marketResults.filter(({ debt }) => debt > 0n).every(({ repayPaused }) => !repayPaused),
    markets: marketResults.map(({ market }) => market),
    specialDebts: [{ kind: "VAI", valueUsdE18: mintedVai === 0n ? "0" : null, supported: mintedVai === 0n }],
  }
}

function validateBlockAge(block: VenusBlock, now: Date, maximumSeconds: number): void {
  if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0) {
    throw new VenusSnapshotError("CONFIGURATION_MISMATCH", "Maximum block age must be positive")
  }
  const age = now.getTime() / 1_000 - Number(block.timestamp)
  if (age < -5) throw new VenusSnapshotError("UPSTREAM_UNAVAILABLE", "Venus Core block timestamp is in the future")
  if (age > maximumSeconds) throw new VenusSnapshotError("STALE_SNAPSHOT", "Venus Core block exceeds the maximum age")
}

function validateIdentity(
  expected: SupportedVenusCoreMarket,
  actual: VenusMarketIdentity,
  comptroller: Address,
): void {
  const underlyingMismatch = expected.native
    ? actual.underlying !== null
    : actual.underlying === null || normalized(actual.underlying) !== normalized(expected.asset)
  const mismatches =
    actual.vTokenSymbol !== expected.vTokenSymbol ||
    normalized(actual.comptroller) !== comptroller ||
    underlyingMismatch ||
    actual.underlyingSymbol !== expected.symbol ||
    actual.underlyingDecimals !== expected.decimals
  if (mismatches) throw new VenusSnapshotError("CONFIGURATION_MISMATCH", `Venus market identity changed for ${expected.vToken}`)
}

function supportedByVToken(markets: readonly SupportedVenusCoreMarket[]): Map<Address, SupportedVenusCoreMarket> {
  const result = new Map<Address, SupportedVenusCoreMarket>()
  for (const market of markets) {
    const address = normalized(market.vToken)
    if (result.has(address)) throw new VenusSnapshotError("CONFIGURATION_MISMATCH", `Duplicate supported market ${address}`)
    result.set(address, { ...market, vToken: address, asset: normalized(market.asset) })
  }
  return result
}

function uniqueAddresses(addresses: readonly Address[]): Address[] {
  return [...new Set(addresses.map(normalized))]
}

function oraclePriceE18(raw: bigint, decimals: number): bigint {
  const exponent = decimals - 18
  return exponent >= 0 ? raw * 10n ** BigInt(exponent) : raw / 10n ** BigInt(-exponent)
}

function mantissaToBps(value: bigint): number {
  const bps = value / 100_000_000_000_000n
  if (bps < 0n || bps > 10_000n) throw new VenusSnapshotError("CONFIGURATION_MISMATCH", "Venus risk factor is out of range")
  return Number(bps)
}

async function mapConcurrent<T, R>(values: readonly T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new VenusSnapshotError("CONFIGURATION_MISMATCH", "Read concurrency must be positive")
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++
      const value = values[index]
      if (value !== undefined) results[index] = await run(value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

function normalized(address: Address): Address {
  return address.toLowerCase() as Address
}

function normalizedHash(hash: Hash): Hash {
  return hash.toLowerCase() as Hash
}
