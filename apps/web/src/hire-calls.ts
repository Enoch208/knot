import { decodeEventLog, encodeFunctionData, getAddress, parseAbi } from "viem"
import type { ConfirmedReceipt, HireEnvelope, PreparedHire, WalletCall } from "./hire-types.ts"

export const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE"
export const ROUTER = "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25"
export const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
export const POLICY = "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"
export const hireAbi = parseAbi([
  "function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)",
  "function registerJob(uint256 jobId,address policy)",
  "function setBudget(uint256 jobId,uint256 amount,bytes optParams)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)",
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)",
])
export const sameAddress = (a: string, b: string): boolean => getAddress(a.toLowerCase()) === getAddress(b.toLowerCase())

export function callsFor(envelope: HireEnvelope): WalletCall[] {
  const call = (to: string, data: string): WalletCall => ({ to, data, value: "0" })
  if (envelope.jobId === null) return [call(COMMERCE, encodeFunctionData({ abi: hireAbi, functionName: "createJob", args: [getAddress(envelope.provider.toLowerCase()), ROUTER, BigInt(envelope.expiredAtUnix), envelope.descriptionSha256Source, ROUTER] }))]
  const id = BigInt(envelope.jobId)
  const budget = BigInt(envelope.budgetBaseUnits)
  return [
    call(ROUTER, encodeFunctionData({ abi: hireAbi, functionName: "registerJob", args: [id, POLICY] })),
    call(COMMERCE, encodeFunctionData({ abi: hireAbi, functionName: "setBudget", args: [id, budget, "0x"] })),
    call(TOKEN, encodeFunctionData({ abi: hireAbi, functionName: "approve", args: [COMMERCE, budget] })),
    call(COMMERCE, encodeFunctionData({ abi: hireAbi, functionName: "fund", args: [id, budget, "0x"] })),
  ]
}

export function validatePrepared(input: unknown, quoteId: string): PreparedHire {
  const p = input as PreparedHire | null
  const e = p?.envelope
  if (!p || !e || p.verifiedQuoteId !== quoteId || e.chainId !== 97 ||
      !["CREATE", "FUND"].includes(p.stage) || (p.stage === "CREATE") !== (e.jobId === null) ||
      (e.jobId !== null && (typeof e.jobId !== "string" || !/^[1-9]\d*$/.test(e.jobId))) ||
      typeof e.budgetBaseUnits !== "string" || !/^[1-9]\d*$/.test(e.budgetBaseUnits) ||
      typeof e.descriptionSha256Source !== "string" || e.descriptionSha256Source.length > 4096 ||
      !Number.isSafeInteger(e.expiredAtUnix) || !Number.isSafeInteger(e.quoteExpiresAtUnix) ||
      !Number.isSafeInteger(e.disputeWindowSeconds) || e.disputeWindowSeconds < 0 ||
      !sameAddress(e.commerce, COMMERCE) || !sameAddress(e.paymentToken, TOKEN) || !sameAddress(e.policy, POLICY)) {
    throw new Error("The prepared hire does not match the pinned testnet boundary.")
  }
  getAddress(e.buyer.toLowerCase())
  getAddress(e.provider.toLowerCase())
  const expected = callsFor(e)
  if (!Array.isArray(p.calls) || e.callCount !== expected.length || p.calls.length !== expected.length ||
      expected.some((call, i) => !p.calls[i] || !sameAddress(call.to, p.calls[i]!.to) || call.data !== p.calls[i]!.data || p.calls[i]!.value !== "0")) {
    throw new Error("Prepared calldata does not match the reviewed terms.")
  }
  return p
}

export function assertReceipt(receipt: ConfirmedReceipt, hash: string, call: WalletCall, buyer: string): void {
  const tx = receipt.transaction
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || tx.chainId !== 97 ||
      !sameAddress(tx.from, buyer) || !tx.to || !sameAddress(tx.to, call.to) || tx.input !== call.data || tx.value !== call.value) {
    throw new Error("Receipt transaction does not match the saved testnet intent.")
  }
}

export function prepareFunding(creation: PreparedHire, receipt: ConfirmedReceipt): PreparedHire {
  validatePrepared(creation, creation.verifiedQuoteId)
  if (creation.stage !== "CREATE" || receipt.status !== "success") throw new Error("A successful creation is required.")
  assertReceipt(receipt, receipt.transactionHash, creation.calls[0]!, creation.envelope.buyer)
  const events = receipt.logs.filter(log => sameAddress(log.address, COMMERCE)).flatMap(log => {
    try { return [decodeEventLog({ abi: hireAbi, eventName: "JobCreated", data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] }).args] } catch { return [] }
  })
  const event = events[0]
  const e = creation.envelope
  if (events.length !== 1 || !event || event.jobId <= 0n || !sameAddress(event.client, e.buyer) ||
      !sameAddress(event.provider, e.provider) || !sameAddress(event.evaluator, ROUTER) ||
      !sameAddress(event.hook, ROUTER) || event.expiredAt !== BigInt(e.expiredAtUnix)) {
    throw new Error("Creation receipt has no unique job matching the reviewed buyer and terms.")
  }
  const envelope: HireEnvelope = { ...e, jobId: event.jobId.toString(), callCount: 4 }
  return { ...creation, stage: "FUND", envelope, calls: callsFor(envelope) }
}
