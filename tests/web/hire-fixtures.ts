import { encodeAbiParameters, encodeEventTopics } from "viem"
import { callsFor, COMMERCE, ROUTER, TOKEN, POLICY, hireAbi } from "../../apps/web/src/hire-calls.ts"
import type { JournalStorage } from "../../apps/web/src/hire-journal.ts"
import type { PreparedHire, ConfirmedReceipt } from "../../apps/web/src/hire-types.ts"
export const buyer = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
export const hash = `0x${"1".repeat(64)}`
export const now = 1_800_000_000
export function prepared(): PreparedHire {
  const envelope = { chainId: 97 as const, jobId: null, buyer, provider: "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389", descriptionSha256Source: "signed description", budgetBaseUnits: "100000000000000000", paymentToken: TOKEN, commerce: COMMERCE, policy: POLICY, disputeWindowSeconds: 900, expiredAtUnix: now + 3600, quoteExpiresAtUnix: now + 600, callCount: 1 }
  return { stage: "CREATE", verifiedQuoteId: "vq-regression", envelope, calls: callsFor(envelope) }
}
export function creationReceipt(): ConfirmedReceipt {
  const p = prepared()
  const call = p.calls[0]!
  return {
    status: "success", transactionHash: hash, blockNumber: "42",
    transaction: { from: buyer, to: call.to, input: call.data, value: "0", chainId: 97 },
    logs: [{ address: COMMERCE,
      topics: encodeEventTopics({ abi: hireAbi, eventName: "JobCreated", args: { jobId: 1234n, client: buyer, provider: p.envelope.provider as `0x${string}` } }) as string[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [ROUTER, BigInt(p.envelope.expiredAtUnix), ROUTER]),
    }],
  }
}
export class MemoryStorage implements JournalStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}
