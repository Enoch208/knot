import assert from "node:assert/strict"
import test from "node:test"
import type { Address, Hash } from "viem"
import {
  collectVenusCoreSnapshot,
  VenusSnapshotError,
  type SupportedVenusCoreMarket,
  type VenusBlock,
  type VenusCoreReader,
  type VenusMarketConfiguration,
  type VenusMarketIdentity,
  type VenusMarketPosition,
} from "../../packages/chain/src/venus-health.ts"

const BORROWER = "0x1111111111111111111111111111111111111111"
const COMPTROLLER = "0x2222222222222222222222222222222222222222"
const ORACLE = "0x3333333333333333333333333333333333333333"
const VTOKEN = "0x4444444444444444444444444444444444444444"
const ASSET = "0x5555555555555555555555555555555555555555"
const UNKNOWN_VTOKEN = "0x6666666666666666666666666666666666666666"
const BLOCK_HASH = `0x${"a".repeat(64)}` as Hash
const OTHER_HASH = `0x${"b".repeat(64)}` as Hash
const BLOCK_TIMESTAMP = 1_788_940_800n
const NOW = new Date(Number(BLOCK_TIMESTAMP + 10n) * 1_000)

const SUPPORTED: readonly SupportedVenusCoreMarket[] = [
  {
    vToken: VTOKEN,
    vTokenSymbol: "vUSDC",
    asset: ASSET,
    symbol: "USDC",
    decimals: 6,
    native: false,
  },
]

class FixtureReader implements VenusCoreReader {
  readonly sourceUri = "fixture://venus-core"
  readonly observedBlocks: bigint[] = []
  head = 105n
  block: VenusBlock = { number: 100n, hash: BLOCK_HASH, timestamp: BLOCK_TIMESTAMP }
  finalHash: Hash = BLOCK_HASH
  inventory: Address[] = [VTOKEN]
  entered: Address[] = [VTOKEN]
  mintedVai = 0n
  protocolPaused = false
  oraclePrice: bigint | null = 10n ** 30n
  repayPaused = false
  forcedLiquidation = false
  positions = new Map<Address, VenusMarketPosition>([
    [VTOKEN, { collateralUnits: 2_000_000n, debtUnits: 1_000_000n }],
  ])
  identity: VenusMarketIdentity = {
    vTokenSymbol: "vUSDC",
    comptroller: COMPTROLLER,
    underlying: ASSET,
    underlyingSymbol: "USDC",
    underlyingDecimals: 6,
  }
  configuration: VenusMarketConfiguration = {
    isListed: true,
    collateralFactorMantissa: 750_000_000_000_000_000n,
    liquidationThresholdMantissa: 800_000_000_000_000_000n,
    marketPoolId: 0n,
    isBorrowAllowed: true,
  }
  private blockReads = 0

  async getHeadBlockNumber(): Promise<bigint> {
    return this.head
  }

  async getBlock(blockNumber: bigint): Promise<VenusBlock> {
    this.observedBlocks.push(blockNumber)
    this.blockReads += 1
    return { ...this.block, hash: this.blockReads > 1 ? this.finalHash : this.block.hash }
  }

  async getAllMarkets(_comptroller: Address, blockNumber: bigint): Promise<readonly Address[]> {
    this.observedBlocks.push(blockNumber)
    return this.inventory
  }

  async getAssetsIn(_comptroller: Address, _borrower: Address, blockNumber: bigint): Promise<readonly Address[]> {
    this.observedBlocks.push(blockNumber)
    return this.entered
  }

  async getOracle(_comptroller: Address, blockNumber: bigint): Promise<Address> {
    this.observedBlocks.push(blockNumber)
    return ORACLE
  }

  async getProtocolPaused(_comptroller: Address, blockNumber: bigint): Promise<boolean> {
    this.observedBlocks.push(blockNumber)
    return this.protocolPaused
  }

  async getMintedVai(_comptroller: Address, _borrower: Address, blockNumber: bigint): Promise<bigint> {
    this.observedBlocks.push(blockNumber)
    return this.mintedVai
  }

  async getMarketPosition(vToken: Address, _borrower: Address, blockNumber: bigint): Promise<VenusMarketPosition> {
    this.observedBlocks.push(blockNumber)
    return this.positions.get(vToken) ?? { collateralUnits: 0n, debtUnits: 0n }
  }

  async getMarketIdentity(_vToken: Address, _native: boolean, blockNumber: bigint): Promise<VenusMarketIdentity> {
    this.observedBlocks.push(blockNumber)
    return this.identity
  }

  async getMarketConfiguration(
    _comptroller: Address,
    _vToken: Address,
    blockNumber: bigint,
  ): Promise<VenusMarketConfiguration> {
    this.observedBlocks.push(blockNumber)
    return this.configuration
  }

  async getUnderlyingPrice(_oracle: Address, _vToken: Address, blockNumber: bigint): Promise<bigint | null> {
    this.observedBlocks.push(blockNumber)
    return this.oraclePrice
  }

  async getRepayPaused(_comptroller: Address, _vToken: Address, blockNumber: bigint): Promise<boolean> {
    this.observedBlocks.push(blockNumber)
    return this.repayPaused
  }

  async getForcedLiquidation(_comptroller: Address, _vToken: Address, blockNumber: bigint): Promise<boolean> {
    this.observedBlocks.push(blockNumber)
    return this.forcedLiquidation
  }
}

function collect(reader: FixtureReader) {
  return collectVenusCoreSnapshot(reader, {
    borrower: BORROWER,
    comptroller: COMPTROLLER,
    supportedMarkets: SUPPORTED,
    confirmationBlocks: 5n,
    maxBlockAgeSeconds: 30,
    now: NOW,
  })
}

test("builds a closed HealthGuard snapshot from one hash-verified block", async () => {
  const reader = new FixtureReader()
  reader.forcedLiquidation = true
  const snapshot = await collect(reader)
  assert.equal(snapshot.schemaVersion, "knot.health.snapshot/1")
  assert.equal(snapshot.blockNumber, "100")
  assert.equal(snapshot.blockHash, BLOCK_HASH)
  assert.equal(snapshot.canonicality, "confirmed")
  assert.equal(snapshot.debtInventoryComplete, true)
  assert.equal(snapshot.forcedLiquidation, "enabled")
  assert.equal(snapshot.actionAvailable, true)
  assert.deepEqual(snapshot.specialDebts, [{ kind: "VAI", valueUsdE18: "0", supported: true }])
  assert.deepEqual(snapshot.markets, [
    {
      asset: ASSET,
      symbol: "USDC",
      decimals: 6,
      collateralUnits: "2000000",
      debtUnits: "1000000",
      oraclePriceUsdE18: "1000000000000000000",
      collateralFactorBps: 7500,
      liquidationThresholdBps: 8000,
      collateralEnabled: true,
      oracleStatus: "current",
      priceObservedAtUtc: new Date(Number(BLOCK_TIMESTAMP) * 1_000).toISOString(),
      supported: true,
    },
  ])
  assert.ok(reader.observedBlocks.length > 10)
  assert.ok(reader.observedBlocks.every((blockNumber) => blockNumber === 100n))
})

test("rejects a position in a market outside the validated allowlist", async () => {
  const reader = new FixtureReader()
  reader.inventory.push(UNKNOWN_VTOKEN)
  reader.positions.set(UNKNOWN_VTOKEN, { collateralUnits: 0n, debtUnits: 1n })
  await assert.rejects(collect(reader), (error: unknown) => {
    assert.ok(error instanceof VenusSnapshotError)
    assert.equal(error.code, "UNSUPPORTED_POSITION")
    return true
  })
})

test("marks positive VAI debt unsupported instead of reporting zero debt", async () => {
  const reader = new FixtureReader()
  reader.positions.set(VTOKEN, { collateralUnits: 0n, debtUnits: 0n })
  reader.mintedVai = 1n
  const snapshot = await collect(reader)
  assert.deepEqual(snapshot.markets, [])
  assert.deepEqual(snapshot.specialDebts, [{ kind: "VAI", valueUsdE18: null, supported: false }])
})

test("marks an unavailable oracle unsupported without manufacturing a price", async () => {
  const reader = new FixtureReader()
  reader.oraclePrice = null
  const snapshot = await collect(reader)
  const market = snapshot.markets[0]
  assert.equal(market?.oracleStatus, "unavailable")
  assert.equal(market?.oraclePriceUsdE18, null)
  assert.equal(market?.priceObservedAtUtc, null)
  assert.equal(market?.supported, false)
})

test("rejects an old source block before producing a snapshot", async () => {
  const reader = new FixtureReader()
  reader.block.timestamp -= 31n
  await assert.rejects(collect(reader), (error: unknown) => {
    assert.ok(error instanceof VenusSnapshotError)
    assert.equal(error.code, "STALE_SNAPSHOT")
    return true
  })
})

test("rejects a block whose hash changes during the read set", async () => {
  const reader = new FixtureReader()
  reader.finalHash = OTHER_HASH
  await assert.rejects(collect(reader), (error: unknown) => {
    assert.ok(error instanceof VenusSnapshotError)
    assert.equal(error.code, "ORPHANED_SNAPSHOT")
    return true
  })
})

test("refuses market identity drift and non-core pool configuration", async () => {
  const identityReader = new FixtureReader()
  identityReader.identity.underlyingDecimals = 18
  await assert.rejects(collect(identityReader), (error: unknown) => {
    assert.ok(error instanceof VenusSnapshotError)
    assert.equal(error.code, "CONFIGURATION_MISMATCH")
    return true
  })
  const missingUnderlyingReader = new FixtureReader()
  missingUnderlyingReader.identity.underlying = null
  await assert.rejects(collect(missingUnderlyingReader), (error: unknown) => {
    assert.ok(error instanceof VenusSnapshotError)
    assert.equal(error.code, "CONFIGURATION_MISMATCH")
    return true
  })
  const poolReader = new FixtureReader()
  poolReader.configuration.marketPoolId = 2n
  const snapshot = await collect(poolReader)
  assert.equal(snapshot.markets[0]?.supported, false)
})
