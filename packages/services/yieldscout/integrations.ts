export const supportedYieldIntegrations = {
  "venus-core-supply-v1": {
    chainId: 56,
    protocol: "venus",
    exposure: "same_asset",
    leverage: false,
    depositSemantics: "mint-vtoken",
    withdrawalSemantics: "redeem-underlying",
  },
  "aave-v3-bsc-supply-v1": {
    chainId: 56,
    protocol: "aave-v3",
    exposure: "same_asset",
    leverage: false,
    depositSemantics: "supply-underlying",
    withdrawalSemantics: "withdraw-underlying",
  },
} as const
