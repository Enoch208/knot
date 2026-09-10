import { keccak256, toHex } from "viem"
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

const JOB_ID_SPACE = 1_000_000_000_000_000n

export function deriveJobId(verifiedQuoteId: string): bigint {
  const digest = keccak256(toHex(`knot.hire/1:${verifiedQuoteId}`))
  return (BigInt(digest) % JOB_ID_SPACE) + 1n
}

export interface HirePreparationInput {
  record: VerifiedQuoteRecord
  nowUnix: number
  jobLifetimeSeconds?: number
}

export interface HirePreparation extends PreparedHire {
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
    jobId: deriveJobId(input.record.id),
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
    ...prepared,
    verifiedQuoteId: input.record.id,
    observedAtUtc: compatibility.observedAtUtc,
    blockNumber: compatibility.blockNumber,
  }
}

export const liveCommerceProbe =
  (createReader: () => CommerceProbeReader, now: () => Date) =>
  async (): Promise<CommerceCompatibility> =>
    verifyTestnetCommerce(createReader(), now().toISOString())
