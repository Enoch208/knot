import {
  HireEnvelopeError,
  prepareHireEnvelope,
  verifyTestnetCommerce,
  type CommerceCompatibility,
  type CommerceProbeReader,
  type PreparedHire,
} from "../../../packages/commerce/src/index.ts"
import type { VerifiedQuoteRecord } from "../../../packages/db/src/index.ts"

export class HirePreparationUnavailableError extends Error {
  readonly reasons: readonly string[]
  constructor(reasons: readonly string[]) {
    super("commerce writes are suspended; a hire cannot be prepared")
    this.name = "HirePreparationUnavailableError"
    this.reasons = reasons
  }
}

export { HireEnvelopeError }

export interface HirePreparationInput {
  record: VerifiedQuoteRecord
  nowUnix: number
  jobLifetimeSeconds?: number
}

export interface HirePreparation {
  stage: "CREATE"
  envelope: Omit<PreparedHire["envelope"], "jobId"> & { jobId: null }
  calls: PreparedHire["calls"]
  verifiedQuoteId: string
  observedAtUtc: string
  blockNumber: string | null
}

export async function prepareHireForVerifiedQuote(
  probe: () => Promise<CommerceCompatibility>,
  input: HirePreparationInput,
): Promise<HirePreparation> {
  const compatibility = await probe()
  if (compatibility.status !== "VERIFIED" || !compatibility.writeAllowed) {
    throw new HirePreparationUnavailableError(
      compatibility.reasons.length > 0 ? compatibility.reasons : ["commerce compatibility not verified"],
    )
  }

  const quote = input.record.quote
  const prepared = prepareHireEnvelope(compatibility, {
    jobId: 1n,
    provider: input.record.sellerOwner,
    buyer: input.record.buyer,
    description: input.record.canonicalJobDescription,
    priceUnits: quote.response.terms.price,
    currency: quote.response.terms.currency,
    quoteExpiresAtUnix: quote.response.quote_expires_at,
    nowUnix: input.nowUnix,
    ...(input.jobLifetimeSeconds === undefined
      ? {}
      : { jobLifetimeSeconds: input.jobLifetimeSeconds }),
  })

  return {
    stage: "CREATE",
    envelope: { ...prepared.envelope, jobId: null, callCount: 1 },
    calls: prepared.calls.slice(0, 1),
    verifiedQuoteId: input.record.id,
    observedAtUtc: compatibility.observedAtUtc,
    blockNumber: compatibility.blockNumber,
  }
}

export const liveCommerceProbe =
  (createReader: () => CommerceProbeReader, now: () => Date) =>
  async (): Promise<CommerceCompatibility> =>
    verifyTestnetCommerce(createReader(), now().toISOString())
