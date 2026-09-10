import { getAddress, type Address } from "viem"
import { requireCommerceWriteReady, type CommerceCompatibility } from "./compatibility.ts"
import { resolveTestnetSdkSource } from "./deployments.ts"
import { prepareHire } from "./hire.ts"

export class HireEnvelopeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "HireEnvelopeError"
    this.code = code
  }
}

export interface HireEnvelopeInput {
  jobId: bigint
  provider: string
  buyer: string
  description: string
  priceUnits: string
  currency: string
  quoteExpiresAtUnix: number
  nowUnix: number
  jobLifetimeSeconds?: number
}

export interface PreparedCall {
  to: Address
  data: `0x${string}`
  value: string
}

export interface HireEnvelope {
  chainId: 97
  jobId: string
  buyer: Address
  provider: Address
  descriptionSha256Source: string
  budgetBaseUnits: string
  paymentToken: Address
  commerce: Address
  policy: Address
  disputeWindowSeconds: number
  expiredAtUnix: number
  quoteExpiresAtUnix: number
  callCount: number
}

export interface PreparedHire {
  envelope: HireEnvelope
  calls: readonly PreparedCall[]
}

const DEFAULT_JOB_LIFETIME_SECONDS = 3600
const MAXIMUM_JOB_LIFETIME_SECONDS = 86_400

const parseBaseUnits = (value: string): bigint => {
  if (!/^[0-9]+$/.test(value)) {
    throw new HireEnvelopeError("PRICE_NOT_BASE_UNITS", "quoted price must be integer base units")
  }
  const units = BigInt(value)
  if (units <= 0n) {
    throw new HireEnvelopeError("PRICE_NOT_POSITIVE", "quoted price must be positive")
  }
  return units
}

export function prepareHireEnvelope(
  compatibility: CommerceCompatibility,
  input: HireEnvelopeInput,
): PreparedHire {
  const policy = requireCommerceWriteReady(compatibility)
  const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment

  if (input.quoteExpiresAtUnix <= input.nowUnix) {
    throw new HireEnvelopeError("QUOTE_EXPIRED", "the signed quote expired before hire preparation")
  }

  const currency = getAddress(input.currency)
  if (currency !== getAddress(deployment.paymentToken)) {
    throw new HireEnvelopeError(
      "CURRENCY_MISMATCH",
      "quoted currency is not the configured commerce payment token",
    )
  }

  const observation = compatibility.policies.find(
    (candidate) => candidate.address.toLowerCase() === policy.toLowerCase(),
  )
  if (!observation) {
    throw new HireEnvelopeError("POLICY_UNOBSERVED", "selected policy has no compatibility observation")
  }

  const disputeWindowSeconds = Number(observation.disputeWindowSeconds)
  if (!Number.isSafeInteger(disputeWindowSeconds) || disputeWindowSeconds < 0) {
    throw new HireEnvelopeError("DISPUTE_WINDOW_UNREADABLE", "policy dispute window is not a whole number of seconds")
  }
  const lifetime = input.jobLifetimeSeconds ?? DEFAULT_JOB_LIFETIME_SECONDS
  if (lifetime <= disputeWindowSeconds || lifetime > MAXIMUM_JOB_LIFETIME_SECONDS) {
    throw new HireEnvelopeError(
      "LIFETIME_OUT_OF_RANGE",
      `job lifetime must exceed the ${disputeWindowSeconds}s dispute window and stay within ${MAXIMUM_JOB_LIFETIME_SECONDS}s`,
    )
  }

  const budget = parseBaseUnits(input.priceUnits)
  const expiredAt = BigInt(input.nowUnix + lifetime)

  const calls = prepareHire(compatibility, {
    jobId: input.jobId,
    provider: getAddress(input.provider) as Address,
    description: input.description,
    budget,
    expiredAt,
    nowSeconds: BigInt(input.nowUnix),
  })

  return {
    envelope: {
      chainId: 97,
      jobId: input.jobId.toString(),
      buyer: getAddress(input.buyer),
      provider: getAddress(input.provider),
      descriptionSha256Source: input.description,
      budgetBaseUnits: budget.toString(),
      paymentToken: getAddress(deployment.paymentToken),
      commerce: getAddress(deployment.commerce),
      policy: getAddress(policy),
      disputeWindowSeconds,
      expiredAtUnix: Number(expiredAt),
      quoteExpiresAtUnix: input.quoteExpiresAtUnix,
      callCount: calls.length,
    },
    calls: calls.map((call) => {
      if (call.data === undefined) {
        throw new HireEnvelopeError("CALL_WITHOUT_DATA", "commerce call is missing calldata")
      }
      return {
        to: getAddress(call.to),
        data: call.data,
        value: (call.value ?? 0n).toString(),
      }
    }),
  }
}
