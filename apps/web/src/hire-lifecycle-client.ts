import { signBuyerIntent } from "./buyer-intent-client.ts"
import type { Eip1193Provider } from "./wallet.ts"

export interface StoredBuyerProof { intent: string; signature: string }
type LifecycleOperation = "funding-confirmation" | "hire-status"

export type LifecycleRequestOutcome =
  | { status: "response"; httpStatus: number; body: unknown; proof: StoredBuyerProof }
  | { status: "rejected" }
  | { status: "unresolved"; detail: string; proof?: StoredBuyerProof }

export async function requestHireLifecycle(
  provider: Eip1193Provider,
  verifiedQuoteId: string,
  buyer: string,
  operation: LifecycleOperation,
  body: unknown,
  existingProof: StoredBuyerProof | undefined,
  onSigned: (proof: StoredBuyerProof) => void,
  fetcher: typeof fetch = fetch,
): Promise<LifecycleRequestOutcome> {
  let proof = existingProof
  const endpoint = `/api/self-service/verified-quotes/${encodeURIComponent(verifiedQuoteId)}/${operation}`
  try {
    if (!proof) {
      const draftResponse = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
        body: JSON.stringify({ stage: "DRAFT", buyer, body }),
        signal: AbortSignal.timeout(10_000),
      })
      const draft = asRecord(await draftResponse.json() as unknown)
      if (!draftResponse.ok || draft.stage !== "SIGNATURE_REQUIRED" || typeof draft.intent !== "string" || typeof draft.message !== "string") {
        return { status: "unresolved", detail: explanation(draft, "Lifecycle authorization could not be prepared.") }
      }
      const signed = await signBuyerIntent(provider, buyer, draft.message)
      if (signed.status === "rejected") return { status: "rejected" }
      if (signed.status !== "signed") return { status: "unresolved", detail: signed.detail }
      proof = { intent: draft.intent, signature: signed.signature }
      onSigned(proof)
    }
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
      body: JSON.stringify({ stage: "SIGNED", intent: proof.intent, signature: proof.signature, body }),
      signal: AbortSignal.timeout(50_000),
    })
    const responseBody = await response.json() as unknown
    return { status: "response", httpStatus: response.status, body: responseBody, proof }
  } catch (error) {
    return { status: "unresolved", detail: error instanceof Error ? error.message : "The lifecycle response could not be reconciled.", ...(proof ? { proof } : {}) }
  }
}

const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const explanation = (value: Record<string, unknown>, fallback: string): string => typeof value.explanation === "string" ? value.explanation : fallback
