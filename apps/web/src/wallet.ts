export const BSC_TESTNET_CHAIN_ID = 97

const CHAIN_ID_HEX = "0x61"
const USER_REJECTED = 4001
const CHAIN_NOT_ADDED = 4902
const RECEIPT_POLL_MILLISECONDS = 3_000
const RECEIPT_DEADLINE_MILLISECONDS = 180_000

const BSC_TESTNET_PARAMETERS = {
  chainId: CHAIN_ID_HEX,
  chainName: "BNB Smart Chain Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: [
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    "https://bsc-testnet-dataseed.bnbchain.org",
  ],
  blockExplorerUrls: ["https://testnet.bscscan.com"],
} as const

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
}

export interface WalletCall {
  to: string
  data: string
  value: string
}

export type AccountOutcome =
  | { status: "connected"; address: string }
  | { status: "rejected" }
  | { status: "unavailable"; detail: string }

export type NetworkOutcome =
  | { status: "ready" }
  | { status: "rejected" }
  | { status: "unavailable"; detail: string }

export type SubmitOutcome =
  | { status: "submitted"; transactionHash: string }
  | { status: "rejected" }
  | { status: "reverted"; detail: string }
  | { status: "unresolved"; detail: string }

export type SettlementOutcome =
  | { status: "confirmed"; transactionHash: string; blockNumber: string }
  | { status: "reverted"; transactionHash: string }
  | { status: "unresolved"; transactionHash: string }

export function readInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null
  const candidate = (window as { ethereum?: unknown }).ethereum
  if (!candidate || typeof candidate !== "object") return null
  const provider = candidate as { request?: unknown }
  return typeof provider.request === "function" ? candidate as Eip1193Provider : null
}

export async function requestAccount(provider: Eip1193Provider): Promise<AccountOutcome> {
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" })
    const address = Array.isArray(accounts) ? accounts[0] : undefined
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { status: "unavailable", detail: "The wallet returned no usable account." }
    }
    return { status: "connected", address }
  } catch (error) {
    if (errorCode(error) === USER_REJECTED) return { status: "rejected" }
    return { status: "unavailable", detail: errorDetail(error) }
  }
}

export async function readChainId(provider: Eip1193Provider): Promise<number | null> {
  try {
    const value = await provider.request({ method: "eth_chainId" })
    if (typeof value !== "string") return null
    const parsed = Number.parseInt(value, 16)
    return Number.isSafeInteger(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function ensureBscTestnet(provider: Eip1193Provider): Promise<NetworkOutcome> {
  if (await readChainId(provider) === BSC_TESTNET_CHAIN_ID) return { status: "ready" }
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    })
  } catch (error) {
    const code = errorCode(error)
    if (code === USER_REJECTED) return { status: "rejected" }
    if (code !== CHAIN_NOT_ADDED) return { status: "unavailable", detail: errorDetail(error) }
    const added = await addBscTestnet(provider)
    if (added.status !== "ready") return added
  }
  return await readChainId(provider) === BSC_TESTNET_CHAIN_ID
    ? { status: "ready" }
    : { status: "unavailable", detail: "The wallet is not connected to BSC testnet (97)." }
}

async function addBscTestnet(provider: Eip1193Provider): Promise<NetworkOutcome> {
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [BSC_TESTNET_PARAMETERS] })
    return { status: "ready" }
  } catch (error) {
    if (errorCode(error) === USER_REJECTED) return { status: "rejected" }
    return { status: "unavailable", detail: errorDetail(error) }
  }
}

export async function submitCall(
  provider: Eip1193Provider,
  from: string,
  call: WalletCall,
): Promise<SubmitOutcome> {
  try {
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from, to: call.to, data: call.data, value: quantity(call.value) }],
    })
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return { status: "unresolved", detail: "The wallet did not return a usable transaction hash." }
    }
    return { status: "submitted", transactionHash: hash }
  } catch (error) {
    const code = errorCode(error)
    if (code === USER_REJECTED) return { status: "rejected" }
    const detail = errorDetail(error)
    if (/revert|execution reverted/i.test(detail)) return { status: "reverted", detail }
    return { status: "unresolved", detail }
  }
}

export async function awaitSettlement(
  provider: Eip1193Provider,
  transactionHash: string,
  deadlineMilliseconds = RECEIPT_DEADLINE_MILLISECONDS,
): Promise<SettlementOutcome> {
  const deadline = Date.now() + deadlineMilliseconds
  while (Date.now() < deadline) {
    const receipt = await readReceipt(provider, transactionHash)
    if (receipt) {
      if (receipt.status === "0x1") {
        return { status: "confirmed", transactionHash, blockNumber: receipt.blockNumber }
      }
      if (receipt.status === "0x0") return { status: "reverted", transactionHash }
      return { status: "unresolved", transactionHash }
    }
    await pause(RECEIPT_POLL_MILLISECONDS)
  }
  return { status: "unresolved", transactionHash }
}

async function readReceipt(
  provider: Eip1193Provider,
  transactionHash: string,
): Promise<{ status: string; blockNumber: string } | null> {
  try {
    const value = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [transactionHash],
    })
    if (!value || typeof value !== "object") return null
    const receipt = value as { status?: unknown; blockNumber?: unknown }
    if (typeof receipt.status !== "string") return null
    return {
      status: receipt.status,
      blockNumber: typeof receipt.blockNumber === "string" ? receipt.blockNumber : "unknown",
    }
  } catch {
    return null
  }
}

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const quantity = (decimalValue: string): string => `0x${BigInt(decimalValue).toString(16)}`

const errorCode = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "number" ? code : null
}

const errorDetail = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "The wallet returned no explanation."
}
