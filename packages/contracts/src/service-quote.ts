import {
  MAX_DESCRIPTION_BYTES,
  NegotiationRequest,
  NegotiationResponse,
  buildDescriptionContent,
  buildJobDescription,
  sanitizeForClaim,
} from "@bnbagent/sdk/erc8183"
import { getAddress, hashMessage, keccak256, recoverMessageAddress, toBytes, type Address, type Hex } from "viem"
import { z } from "zod"

const MAX_UINT256 = (1n << 256n) - 1n
const MAX_QUOTE_TTL_SECONDS = 900

const nonEmptyText = z.string().min(1)
const requestId = z.string().min(16).max(256).regex(/^[A-Za-z0-9._:-]+$/)
const rawAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const digest = z.string().regex(/^0x[0-9a-f]{64}$/)
const signature = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/)
const decimalUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
const positiveTimestamp = z.number().int().positive().safe()

const requestedTerms = z
  .object({
    deliverables: nonEmptyText,
    quality_standards: nonEmptyText,
    success_criteria: z.array(nonEmptyText).min(1).optional(),
  })
  .strict()

const sentRequestSchema = z
  .object({
    task_description: nonEmptyText,
    terms: requestedTerms,
    request_id: requestId,
    context_urls: z.array(z.url()).min(1).optional(),
  })
  .strict()

const normalizedTerms = z
  .object({
    deliverables: nonEmptyText,
    quality_standards: nonEmptyText,
    success_criteria: z.array(nonEmptyText).min(1).optional(),
    evaluation_required: z.literal(true),
    evaluator_type: z.literal("uma_oov3"),
  })
  .strict()

const quotedTerms = normalizedTerms
  .extend({
    price: decimalUnits,
    currency: rawAddress,
  })
  .strict()

const quoteSchema = z
  .object({
    request: z
      .object({
        task_description: nonEmptyText,
        terms: normalizedTerms,
        request_id: requestId,
        context_urls: z.array(z.url()).min(1).optional(),
      })
      .strict(),
    request_hash: digest,
    response: z
      .object({
        accepted: z.literal(true),
        terms: quotedTerms,
        estimated_completion_seconds: z.number().int().positive().safe(),
        quote_expires_at: positiveTimestamp,
        negotiated_at: positiveTimestamp,
      })
      .strict(),
    response_hash: digest,
    negotiation_hash: digest,
    provider_sig: signature,
    chain_id: z.number().int().positive().safe(),
    verifying_contract: rawAddress,
  })
  .strict()

const expectationSchema = z
  .object({
    provider: rawAddress,
    providerKind: z.enum(["eoa", "erc1271"]),
    chainId: z.literal(97),
    verifyingContract: rawAddress,
    currency: rawAddress,
    maxPriceUnits: decimalUnits,
    taskDescription: nonEmptyText,
    terms: requestedTerms,
    requestId,
  })
  .strict()

export type OwnedSellerRequestedTerms = z.infer<typeof requestedTerms>
export type OwnedSellerNegotiationQuote = z.infer<typeof quoteSchema>

export interface OwnedSellerQuoteExpectation {
  provider: string
  providerKind: "eoa" | "erc1271"
  chainId: 97
  verifyingContract: string
  currency: string
  maxPriceUnits: string
  taskDescription: string
  terms: OwnedSellerRequestedTerms
  requestId: string
}

export interface VerifyOwnedSellerQuoteInput {
  sentRequest: unknown
  quote: unknown
  expected: OwnedSellerQuoteExpectation
  nowUnix: number
  maxFutureSkewSeconds?: number
}

export type ServiceQuoteVerificationErrorCode =
  | "INVALID_EXPECTATION"
  | "INVALID_SENT_REQUEST"
  | "INVALID_QUOTE"
  | "CONTEXT_URLS_FORBIDDEN"
  | "REQUEST_BINDING_MISMATCH"
  | "SANITIZATION_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "PRICE_INVALID"
  | "TIME_INVALID"
  | "HASH_MISMATCH"
  | "DESCRIPTION_INVALID"
  | "SIGNER_MISMATCH"

export class ServiceQuoteVerificationError extends Error {
  readonly code: ServiceQuoteVerificationErrorCode

  constructor(code: ServiceQuoteVerificationErrorCode, message: string) {
    super(message)
    this.name = "ServiceQuoteVerificationError"
    this.code = code
  }
}

interface VerifiedQuoteCore {
  schemaVersion: "knot.verified-owned-seller-quote/1"
  provider: Address
  chainId: 97
  verifyingContract: Address
  currency: Address
  priceUnits: string
  taskDescription: string
  terms: OwnedSellerRequestedTerms
  requestId: string
  estimatedCompletionSeconds: number
  negotiatedAtUnix: number
  quoteExpiresAtUnix: number
  requestHash: Hex
  responseHash: Hex
  negotiationHash: Hex
  providerSignature: Hex
  canonicalJobDescription: string
  quote: OwnedSellerNegotiationQuote
}

export interface VerifiedEoaServiceQuote extends VerifiedQuoteCore {
  status: "VERIFIED_EOA"
  signatureMethod: "eip191"
}

export interface UnresolvedErc1271ServiceQuote extends VerifiedQuoteCore {
  status: "ERC1271_UNRESOLVED"
  challenge: {
    contract: Address
    digest: Hex
    signature: Hex
    chainId: 97
    caller: Address
  }
}

export type OwnedSellerQuoteVerification = VerifiedEoaServiceQuote | UnresolvedErc1271ServiceQuote

export interface IntegrityCheckedOwnedSellerQuote {
  status: "INTEGRITY_CHECKED_NOT_SIGNATURE_VERIFIED"
  quote: OwnedSellerNegotiationQuote
  requestHash: Hex
  responseHash: Hex
  negotiationHash: Hex
  canonicalJobDescription: string
}

const fail = (code: ServiceQuoteVerificationErrorCode, message: string): never => {
  throw new ServiceQuoteVerificationError(code, message)
}

const requireCondition = (
  condition: boolean,
  code: ServiceQuoteVerificationErrorCode,
  message: string,
): void => {
  if (!condition) fail(code, message)
}

const canonicalJson = (value: unknown): string => {
  const sortValue = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sortValue)
    if (entry !== null && typeof entry === "object") {
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(entry).sort()) {
        output[key] = sortValue((entry as Record<string, unknown>)[key])
      }
      return output
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new TypeError("non-finite JSON number")
    return entry
  }
  return JSON.stringify(sortValue(value)).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

const equalCanonical = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)

const equalOptionalCanonical = (left: unknown, right: unknown): boolean =>
  left === undefined && right === undefined ? true : equalCanonical(left, right)

const parseAddress = (value: string): Address => getAddress(value).toLowerCase() as Address

const requireSanitizeIdentity = (value: string, label: string): void => {
  requireCondition(sanitizeForClaim(value) === value, "SANITIZATION_MISMATCH", `${label} changes under claim sanitization`)
}

const assertSanitizeIdentity = (taskDescription: string, terms: OwnedSellerRequestedTerms): void => {
  requireSanitizeIdentity(taskDescription, "task description")
  requireSanitizeIdentity(terms.deliverables, "deliverables")
  requireSanitizeIdentity(terms.quality_standards, "quality standards")
  for (const criterion of terms.success_criteria ?? []) requireSanitizeIdentity(criterion, "success criterion")
}

const parsePositiveUint256 = (value: string, label: string): bigint => {
  const parsed = BigInt(value)
  requireCondition(parsed > 0n && parsed <= MAX_UINT256, "PRICE_INVALID", `${label} must be a positive uint256`)
  return parsed
}

const parseInput = <T>(schema: z.ZodType<T>, value: unknown, code: ServiceQuoteVerificationErrorCode): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ServiceQuoteVerificationError(code, parsed.error.issues[0]?.message ?? "schema validation failed")
  return parsed.data
}

const recomputeHashes = (quote: z.infer<typeof quoteSchema>): {
  requestHash: Hex
  responseHash: Hex
  negotiationHash: Hex
} => {
  const requestHash = NegotiationRequest.fromDict(quote.request).computeHash() as Hex
  const responseHash = NegotiationResponse.fromDict(quote.response).computeHash() as Hex
  const content = buildDescriptionContent(quote, quote.chain_id, quote.verifying_contract)
  const negotiationHash = keccak256(toBytes(canonicalJson(content)))
  return { requestHash, responseHash, negotiationHash }
}

export const recheckOwnedSellerQuoteIntegrity = (value: unknown): IntegrityCheckedOwnedSellerQuote => {
  const quote = parseInput(quoteSchema, value, "INVALID_QUOTE")
  const hashes = recomputeHashes(quote)
  requireCondition(quote.request_hash === hashes.requestHash, "HASH_MISMATCH", "request hash does not match")
  requireCondition(quote.response_hash === hashes.responseHash, "HASH_MISMATCH", "response hash does not match")
  requireCondition(quote.negotiation_hash === hashes.negotiationHash, "HASH_MISMATCH", "negotiation hash does not match")
  const canonicalJobDescription = (() => {
    try {
      return buildJobDescription(quote)
    } catch (error) {
      throw new ServiceQuoteVerificationError("DESCRIPTION_INVALID", error instanceof Error ? error.message : "job description is invalid")
    }
  })()
  requireCondition(Buffer.byteLength(canonicalJobDescription, "utf8") <= MAX_DESCRIPTION_BYTES, "DESCRIPTION_INVALID", "job description exceeds the SDK byte limit")
  return {
    status: "INTEGRITY_CHECKED_NOT_SIGNATURE_VERIFIED",
    quote,
    requestHash: hashes.requestHash,
    responseHash: hashes.responseHash,
    negotiationHash: hashes.negotiationHash,
    canonicalJobDescription,
  }
}

const buildCore = (
  quote: z.infer<typeof quoteSchema>,
  expected: z.infer<typeof expectationSchema>,
  hashes: { requestHash: Hex; responseHash: Hex; negotiationHash: Hex },
  canonicalJobDescription: string,
): VerifiedQuoteCore => ({
  schemaVersion: "knot.verified-owned-seller-quote/1",
  provider: parseAddress(expected.provider),
  chainId: 97,
  verifyingContract: parseAddress(quote.verifying_contract),
  currency: parseAddress(quote.response.terms.currency),
  priceUnits: quote.response.terms.price,
  taskDescription: quote.request.task_description,
  terms: expected.terms,
  requestId: quote.request.request_id,
  estimatedCompletionSeconds: quote.response.estimated_completion_seconds,
  negotiatedAtUnix: quote.response.negotiated_at,
  quoteExpiresAtUnix: quote.response.quote_expires_at,
  requestHash: hashes.requestHash,
  responseHash: hashes.responseHash,
  negotiationHash: hashes.negotiationHash,
  providerSignature: quote.provider_sig as Hex,
  canonicalJobDescription,
  quote,
})

export const verifyOwnedSellerQuote = async (
  input: VerifyOwnedSellerQuoteInput,
): Promise<OwnedSellerQuoteVerification> => {
  const expected = parseInput(expectationSchema, input.expected, "INVALID_EXPECTATION")
  const sentRequest = parseInput(sentRequestSchema, input.sentRequest, "INVALID_SENT_REQUEST")
  const quote = parseInput(quoteSchema, input.quote, "INVALID_QUOTE")
  requireCondition(Number.isSafeInteger(input.nowUnix) && input.nowUnix > 0, "TIME_INVALID", "nowUnix must be a positive safe integer")
  const maxFutureSkewSeconds = input.maxFutureSkewSeconds ?? 30
  requireCondition(
    Number.isSafeInteger(maxFutureSkewSeconds) && maxFutureSkewSeconds >= 0 && maxFutureSkewSeconds <= 300,
    "TIME_INVALID",
    "maxFutureSkewSeconds must be a safe integer from 0 to 300",
  )
  requireCondition(sentRequest.context_urls === undefined && quote.request.context_urls === undefined, "CONTEXT_URLS_FORBIDDEN", "context URLs are not accepted")
  requireCondition(sentRequest.request_id === expected.requestId, "REQUEST_BINDING_MISMATCH", "sent request ID does not match the expected nonce")
  requireCondition(sentRequest.task_description === expected.taskDescription, "REQUEST_BINDING_MISMATCH", "sent task description does not match the expected request")
  requireCondition(equalCanonical(sentRequest.terms, expected.terms), "REQUEST_BINDING_MISMATCH", "sent terms do not match the expected terms")
  assertSanitizeIdentity(sentRequest.task_description, sentRequest.terms)
  const normalizedSentRequest = NegotiationRequest.fromDict(sentRequest).toDict()
  requireCondition(equalCanonical(quote.request, normalizedSentRequest), "REQUEST_BINDING_MISMATCH", "quoted request is not the exact normalized sent request")
  requireCondition(quote.chain_id === expected.chainId, "DOMAIN_MISMATCH", "quote chain does not match BSC testnet")
  requireCondition(parseAddress(quote.verifying_contract) === parseAddress(expected.verifyingContract), "DOMAIN_MISMATCH", "quote commerce contract does not match")
  requireCondition(parseAddress(quote.response.terms.currency) === parseAddress(expected.currency), "DOMAIN_MISMATCH", "quote payment token does not match")
  requireCondition(quote.response.terms.deliverables === sentRequest.terms.deliverables, "REQUEST_BINDING_MISMATCH", "response deliverables changed")
  requireCondition(quote.response.terms.quality_standards === sentRequest.terms.quality_standards, "REQUEST_BINDING_MISMATCH", "response quality standards changed")
  requireCondition(equalOptionalCanonical(quote.response.terms.success_criteria, sentRequest.terms.success_criteria), "REQUEST_BINDING_MISMATCH", "response success criteria changed")
  assertSanitizeIdentity(quote.request.task_description, {
    deliverables: quote.response.terms.deliverables,
    quality_standards: quote.response.terms.quality_standards,
    ...(quote.response.terms.success_criteria === undefined ? {} : { success_criteria: quote.response.terms.success_criteria }),
  })
  const price = parsePositiveUint256(quote.response.terms.price, "quote price")
  const cap = parsePositiveUint256(expected.maxPriceUnits, "price cap")
  requireCondition(price <= cap, "PRICE_INVALID", "quote price exceeds the expected cap")
  const ttl = quote.response.quote_expires_at - quote.response.negotiated_at
  requireCondition(ttl >= 1 && ttl <= MAX_QUOTE_TTL_SECONDS, "TIME_INVALID", "quote TTL must be between 1 and 900 seconds")
  requireCondition(quote.response.quote_expires_at > input.nowUnix, "TIME_INVALID", "quote is expired")
  requireCondition(quote.response.negotiated_at <= input.nowUnix + maxFutureSkewSeconds, "TIME_INVALID", "quote negotiation time is in the future")
  const integrity = recheckOwnedSellerQuoteIntegrity(quote)
  const hashes = {
    requestHash: integrity.requestHash,
    responseHash: integrity.responseHash,
    negotiationHash: integrity.negotiationHash,
  }
  const core = buildCore(integrity.quote, expected, hashes, integrity.canonicalJobDescription)
  if (expected.providerKind === "erc1271") {
    return {
      ...core,
      status: "ERC1271_UNRESOLVED",
      challenge: {
        contract: parseAddress(expected.provider),
        digest: hashMessage(quote.negotiation_hash),
        signature: quote.provider_sig as Hex,
        chainId: 97,
        caller: parseAddress(expected.verifyingContract),
      },
    }
  }
  const recovered = await recoverMessageAddress({ message: quote.negotiation_hash, signature: quote.provider_sig as Hex })
    .catch(() => fail("SIGNER_MISMATCH", "provider signature is not a valid EIP-191 EOA signature"))
  requireCondition(parseAddress(recovered) === parseAddress(expected.provider), "SIGNER_MISMATCH", "provider signature does not recover to the expected owner")
  return { ...core, status: "VERIFIED_EOA", signatureMethod: "eip191" }
}
