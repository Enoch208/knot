import assert from "node:assert/strict"
import test from "node:test"
import { collectVenusCoreSnapshot } from "../../packages/chain/src/venus-health.ts"
import {
  createBscVenusCoreReader,
  VENUS_CORE_BSC_SUPPORTED_MARKETS,
  VENUS_CORE_COMPTROLLER,
} from "../../packages/chain/src/venus-health-viem.ts"

const rpcUrl = process.env.KNOT_LIVE_VENUS_RPC?.trim()

test(
  "reads the live Venus Core inventory at a confirmed BSC block",
  { skip: rpcUrl ? false : "KNOT_LIVE_VENUS_RPC is required" },
  async () => {
    const reader = createBscVenusCoreReader(rpcUrl)
    const snapshot = await collectVenusCoreSnapshot(reader, {
      borrower: "0x553972e14d7aba642641971074b042aba55ad06e",
      comptroller: VENUS_CORE_COMPTROLLER,
      supportedMarkets: VENUS_CORE_BSC_SUPPORTED_MARKETS,
      confirmationBlocks: 5n,
      maxBlockAgeSeconds: 60,
      readConcurrency: 4,
    })
    assert.equal(snapshot.chainId, 56)
    assert.equal(snapshot.debtInventoryComplete, true)
    assert.equal(snapshot.canonicality, "confirmed")
    const blockNumber = BigInt(snapshot.blockNumber)
    const supported = VENUS_CORE_BSC_SUPPORTED_MARKETS[1]
    assert.ok(supported)
    const [identity, configuration] = await Promise.all([
      reader.getMarketIdentity(supported.vToken, supported.native, blockNumber),
      reader.getMarketConfiguration(VENUS_CORE_COMPTROLLER, supported.vToken, blockNumber),
    ])
    assert.equal(identity.underlying?.toLowerCase(), supported.asset)
    assert.equal(configuration.isListed, true)
    assert.equal(configuration.marketPoolId, 0n)
  },
)
