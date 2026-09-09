import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem"
import { bsc } from "viem/chains"
import { MAINNET } from "./manifest.ts"
import type {
  VenusBlock,
  VenusCoreReader,
  VenusMarketConfiguration,
  VenusMarketIdentity,
  VenusMarketPosition,
} from "./venus-health.ts"

const comptrollerAbi = parseAbi([
  "function getAllMarkets() view returns (address[])",
  "function getAssetsIn(address account) view returns (address[])",
  "function oracle() view returns (address)",
  "function protocolPaused() view returns (bool)",
  "function mintedVAIs(address user) view returns (uint256)",
  "function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function actionPaused(address market, uint8 action) view returns (bool)",
  "function isForcedLiquidationEnabled(address market) view returns (bool)",
])

const vTokenAbi = parseAbi([
  "function balanceOfUnderlying(address owner) returns (uint256)",
  "function borrowBalanceCurrent(address account) returns (uint256)",
  "function symbol() view returns (string)",
  "function comptroller() view returns (address)",
  "function underlying() view returns (address)",
])

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
])

const oracleAbi = parseAbi(["function getUnderlyingPrice(address vToken) view returns (uint256)"])

export const VENUS_CORE_COMPTROLLER = "0xfd36e2c2a6789db23113685031d7f16329158384" as const
export const NATIVE_BNB = "0x0000000000000000000000000000000000000000" as const

export const VENUS_CORE_BSC_SUPPORTED_MARKETS = [
  {
    vToken: "0xa07c5b74c9b40447a954e1466938b865b6bbea36",
    vTokenSymbol: "vBNB",
    asset: NATIVE_BNB,
    symbol: "BNB",
    decimals: 18,
    native: true,
  },
  {
    vToken: "0xeca88125a5adbe82614ffc12d0db554e2e2867c8",
    vTokenSymbol: "vUSDC",
    asset: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    symbol: "USDC",
    decimals: 18,
    native: false,
  },
  {
    vToken: "0xfd5840cd36d94d7229439859c0112a4185bc0255",
    vTokenSymbol: "vUSDT",
    asset: "0x55d398326f99059ff775485246999027b3197955",
    symbol: "USDT",
    decimals: 18,
    native: false,
  },
] as const

export class ViemVenusCoreReader implements VenusCoreReader {
  readonly sourceUri: string
  private readonly client: PublicClient

  constructor(client: PublicClient, sourceUri: string) {
    this.client = client
    this.sourceUri = sourceUri
  }

  getHeadBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  async getBlock(blockNumber: bigint): Promise<VenusBlock> {
    const block = await this.client.getBlock({ blockNumber })
    if (block.hash === null) throw new Error("Block hash unavailable")
    return { number: block.number, hash: block.hash, timestamp: block.timestamp }
  }

  getAllMarkets(comptroller: Address, blockNumber: bigint): Promise<readonly Address[]> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "getAllMarkets", blockNumber })
  }

  getAssetsIn(comptroller: Address, borrower: Address, blockNumber: bigint): Promise<readonly Address[]> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "getAssetsIn", args: [borrower], blockNumber })
  }

  getOracle(comptroller: Address, blockNumber: bigint): Promise<Address> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "oracle", blockNumber })
  }

  getProtocolPaused(comptroller: Address, blockNumber: bigint): Promise<boolean> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "protocolPaused", blockNumber })
  }

  getMintedVai(comptroller: Address, borrower: Address, blockNumber: bigint): Promise<bigint> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "mintedVAIs", args: [borrower], blockNumber })
  }

  async getMarketPosition(vToken: Address, borrower: Address, blockNumber: bigint): Promise<VenusMarketPosition> {
    const [collateralUnits, debtUnits] = await Promise.all([
      this.callPosition(vToken, "balanceOfUnderlying", borrower, blockNumber),
      this.callPosition(vToken, "borrowBalanceCurrent", borrower, blockNumber),
    ])
    return { collateralUnits, debtUnits }
  }

  private async callPosition(
    vToken: Address,
    functionName: "balanceOfUnderlying" | "borrowBalanceCurrent",
    borrower: Address,
    blockNumber: bigint,
  ): Promise<bigint> {
    const data = encodeFunctionData({ abi: vTokenAbi, functionName, args: [borrower] })
    const response = await this.client.call({ to: vToken, data, blockNumber })
    if (response.data === undefined) throw new Error("Venus market returned no position data")
    return decodeFunctionResult({ abi: vTokenAbi, functionName, data: response.data })
  }

  async getMarketIdentity(vToken: Address, native: boolean, blockNumber: bigint): Promise<VenusMarketIdentity> {
    const [vTokenSymbol, comptroller] = await Promise.all([
      this.client.readContract({ address: vToken, abi: vTokenAbi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address: vToken, abi: vTokenAbi, functionName: "comptroller", blockNumber }),
    ])
    if (native) return { vTokenSymbol, comptroller, underlying: null, underlyingSymbol: "BNB", underlyingDecimals: 18 }
    const underlying = await this.client.readContract({ address: vToken, abi: vTokenAbi, functionName: "underlying", blockNumber })
    const [underlyingSymbol, underlyingDecimals] = await Promise.all([
      this.client.readContract({ address: underlying, abi: tokenAbi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address: underlying, abi: tokenAbi, functionName: "decimals", blockNumber }),
    ])
    return { vTokenSymbol, comptroller, underlying, underlyingSymbol, underlyingDecimals }
  }

  async getMarketConfiguration(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<VenusMarketConfiguration> {
    const [isListed, collateralFactorMantissa, , liquidationThresholdMantissa, , marketPoolId, isBorrowAllowed] =
      await this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "markets", args: [vToken], blockNumber })
    return { isListed, collateralFactorMantissa, liquidationThresholdMantissa, marketPoolId, isBorrowAllowed }
  }

  async getUnderlyingPrice(oracle: Address, vToken: Address, blockNumber: bigint): Promise<bigint | null> {
    try {
      return await this.client.readContract({ address: oracle, abi: oracleAbi, functionName: "getUnderlyingPrice", args: [vToken], blockNumber })
    } catch {
      return null
    }
  }

  getRepayPaused(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<boolean> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "actionPaused", args: [vToken, 3], blockNumber })
  }

  getForcedLiquidation(comptroller: Address, vToken: Address, blockNumber: bigint): Promise<boolean> {
    return this.client.readContract({ address: comptroller, abi: comptrollerAbi, functionName: "isForcedLiquidationEnabled", args: [vToken], blockNumber })
  }
}

export function createBscVenusCoreReader(rpcUrl = MAINNET.rpcUrls[0]): ViemVenusCoreReader {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) })
  return new ViemVenusCoreReader(client, "bsc://56/venus-core")
}
