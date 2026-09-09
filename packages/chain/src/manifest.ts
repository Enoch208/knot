export type ChainId = 56 | 97

export type IntegrationStatus = "VERIFIED" | "READ_ONLY" | "DISABLED" | "UNRESOLVED"

export type ContractRole = "commerce" | "router" | "policy" | "registry" | "paymentToken"

export interface DeclaredContract {
  role: ContractRole
  address: `0x${string}`
  declaredBy: string
  conflictsWith?: { address: `0x${string}`; declaredBy: string }
}

export interface NetworkManifest {
  chainId: ChainId
  label: string
  writeEnabled: boolean
  rpcUrls: readonly string[]
  contracts: readonly DeclaredContract[]
}

const ALTANA = "@altananetwork/sdk@0.7.1 ERC8183_ADDRESSES"
const BNBAGENT = "@bnbagent/sdk@0.5.5 NETWORKS"

export const MAINNET: NetworkManifest = {
  chainId: 56,
  label: "BSC mainnet",
  writeEnabled: false,
  rpcUrls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io"],
  contracts: [
    { role: "commerce", address: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "router", address: "0x51895229E12F9876011789B04f8698af06cCD6DA", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "policy", address: "0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "registry", address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "paymentToken", address: "0xcE24439F2D9C6a2289F741120FE202248B666666", declaredBy: ALTANA },
  ],
}

export const TESTNET: NetworkManifest = {
  chainId: 97,
  label: "BSC testnet",
  writeEnabled: true,
  rpcUrls: [
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet-dataseed.bnbchain.org",
  ],
  contracts: [
    { role: "commerce", address: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "router", address: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    {
      role: "policy",
      address: "0xd6a4217588f6b1f5657a92a3e94e6422ad771cea",
      declaredBy: BNBAGENT,
    },
    { role: "registry", address: "0x8004A818BFB912233c491871b3d84c89A494BD9e", declaredBy: `${ALTANA} + ${BNBAGENT}` },
    { role: "paymentToken", address: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", declaredBy: ALTANA },
  ],
}

export const MANIFESTS: Record<ChainId, NetworkManifest> = { 56: MAINNET, 97: TESTNET }

export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const

export const ERC1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const
