import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem"

export interface CommerceProbeReader {
  chainId(): Promise<number>
  blockNumber(): Promise<bigint>
  codeHash(address: Address): Promise<Hex | null>
  implementation(address: Address): Promise<Address | null>
  routerCommerce(router: Address): Promise<Address>
  routerPaused(router: Address): Promise<boolean>
  policyWhitelisted(router: Address, policy: Address): Promise<boolean>
  paymentToken(commerce: Address): Promise<Address>
  policyCommerce(policy: Address): Promise<Address>
  policyRouter(policy: Address): Promise<Address>
  disputeWindow(policy: Address): Promise<bigint>
}

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const
const ZERO_WORD = `0x${"0".repeat(64)}` as Hex
const addressView = (name: string) =>
  [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const

export function createCommerceProbeReader(rpcUrl: string): CommerceProbeReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) })
  return {
    chainId: () => client.getChainId(),
    blockNumber: () => client.getBlockNumber(),
    codeHash: async (contract) => {
      const code = await client.getCode({ address: contract })
      return code && code !== "0x" ? keccak256(code) : null
    },
    implementation: async (contract) => {
      const word = await client.getStorageAt({ address: contract, slot: IMPLEMENTATION_SLOT })
      return word && word !== ZERO_WORD ? getAddress(`0x${word.slice(26)}`) : null
    },
    routerCommerce: (router) =>
      client.readContract({ address: router, abi: addressView("commerce"), functionName: "commerce" }),
    routerPaused: (router) =>
      client.readContract({
        address: router,
        abi: [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }],
        functionName: "paused",
      }),
    policyWhitelisted: (router, policy) =>
      client.readContract({
        address: router,
        abi: [{ type: "function", name: "policyWhitelist", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }],
        functionName: "policyWhitelist",
        args: [policy],
      }),
    paymentToken: (commerce) =>
      client.readContract({ address: commerce, abi: addressView("paymentToken"), functionName: "paymentToken" }),
    policyCommerce: (policy) =>
      client.readContract({ address: policy, abi: addressView("commerce"), functionName: "commerce" }),
    policyRouter: (policy) =>
      client.readContract({ address: policy, abi: addressView("router"), functionName: "router" }),
    disputeWindow: (policy) =>
      client.readContract({
        address: policy,
        abi: [{ type: "function", name: "disputeWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }],
        functionName: "disputeWindow",
      }),
  }
}
