import { zeroAddress, type Address, type Hex } from "viem"
import { requireCommerceWriteReady, type CommerceCompatibility } from "../../commerce/src/compatibility.ts"
import type { PreparedHire } from "../../commerce/src/hire-envelope.ts"
import { refuse, SessionHireAuthorityError } from "./errors.ts"
import { deriveAllowedSessionCalls, type AllowedSessionCall, type ManifestTarget } from "./hire-call-scope.ts"
import { smallestSpendWindowContaining, type SpendPeriod, type SpendWindow } from "./spend-period.ts"

export const MAXIMUM_RELAY_FEE_ALLOWANCE_WEI = 5_000_000_000_000_000n

export interface SessionHireAuthorityOptions {
  nowUnix: number
  relayFeeAllowanceWei?: bigint
  tokenCapBaseUnits?: bigint
  expiryUnix?: number
}

export interface SessionSpendLimit {
  token: Address
  period: SpendPeriod
  periodCode: number
  limitBaseUnits: string
}

export interface SessionCallPermission {
  signature: Hex
  to: Address
}

export interface SessionSpendPermission {
  limit: bigint
  period: SpendPeriod
  token?: Address
}

export interface SessionGrantPermissions {
  calls: readonly SessionCallPermission[]
  spend: readonly SessionSpendPermission[]
}

export interface SessionHireAuthority {
  chainId: 97
  jobId: string
  account: Address
  provider: Address
  policy: Address
  allowedCalls: readonly AllowedSessionCall[]
  tokenSpend: SessionSpendLimit
  nativeSpend: SessionSpendLimit
  expiryUnix: number
  sessionStartUnix: number
  jobExpiredAtUnix: number
  spendWindow: SpendWindow
  manifestTargets: readonly ManifestTarget[]
  permissions: SessionGrantPermissions
}

const requireVerifiedCommerce = (compatibility: CommerceCompatibility, policy: Address): void => {
  let selected: Address
  try {
    selected = requireCommerceWriteReady(compatibility)
  } catch (error) {
    throw new SessionHireAuthorityError(
      "COMMERCE_NOT_VERIFIED",
      error instanceof Error ? error.message : "commerce compatibility was not verified",
    )
  }
  if (selected.toLowerCase() !== policy.toLowerCase()) {
    refuse("POLICY_NOT_SELECTED", `the envelope policy ${policy} is not the verified policy ${selected}`)
  }
}

const resolveExpiry = (
  options: SessionHireAuthorityOptions,
  jobExpiredAtUnix: number,
): number => {
  if (jobExpiredAtUnix <= options.nowUnix) {
    refuse("JOB_ALREADY_EXPIRED", `job expiry ${jobExpiredAtUnix} is not after ${options.nowUnix}`)
  }
  const expiryUnix = options.expiryUnix ?? jobExpiredAtUnix
  if (expiryUnix <= options.nowUnix) {
    refuse("EXPIRY_NOT_FUTURE", `session expiry ${expiryUnix} is not after ${options.nowUnix}`)
  }
  if (expiryUnix > jobExpiredAtUnix) {
    refuse("EXPIRY_OUTLIVES_JOB", `session expiry ${expiryUnix} outlives the job expiry ${jobExpiredAtUnix}`)
  }
  return expiryUnix
}

const resolveTokenCap = (options: SessionHireAuthorityOptions, budget: bigint): bigint => {
  if (budget <= 0n) refuse("BUDGET_NOT_POSITIVE", "a spend-scoped session needs a positive hire budget")
  const cap = options.tokenCapBaseUnits ?? budget
  if (cap > budget) {
    refuse("TOKEN_CAP_EXCEEDS_BUDGET", `a ${cap} base-unit cap exceeds the ${budget} base-unit hire budget`)
  }
  if (cap < budget) {
    refuse("TOKEN_CAP_BELOW_BUDGET", `a ${cap} base-unit cap cannot fund the ${budget} base-unit hire`)
  }
  return cap
}

const resolveRelayAllowance = (options: SessionHireAuthorityOptions): bigint => {
  const allowance = options.relayFeeAllowanceWei ?? MAXIMUM_RELAY_FEE_ALLOWANCE_WEI
  if (allowance <= 0n) {
    refuse("RELAY_ALLOWANCE_NOT_POSITIVE", "a session that pays its own relay fee needs a positive native allowance")
  }
  if (allowance > MAXIMUM_RELAY_FEE_ALLOWANCE_WEI) {
    refuse(
      "RELAY_ALLOWANCE_ABOVE_CEILING",
      `a ${allowance} wei native allowance exceeds the ${MAXIMUM_RELAY_FEE_ALLOWANCE_WEI} wei relay-fee ceiling`,
    )
  }
  return allowance
}

export function deriveSessionHireAuthority(
  compatibility: CommerceCompatibility,
  prepared: PreparedHire,
  options: SessionHireAuthorityOptions,
): SessionHireAuthority {
  const { envelope, calls } = prepared
  requireVerifiedCommerce(compatibility, envelope.policy)

  const budget = BigInt(envelope.budgetBaseUnits)
  const tokenCap = resolveTokenCap(options, budget)
  const relayAllowance = resolveRelayAllowance(options)
  const expiryUnix = resolveExpiry(options, envelope.expiredAtUnix)
  const spendWindow = smallestSpendWindowContaining(options.nowUnix, expiryUnix)
  if (spendWindow === null) {
    refuse(
      "SPEND_WINDOW_UNBOUNDED",
      `no rolling spend period contains ${options.nowUnix}..${expiryUnix}, so the cap could refresh mid-session`,
    )
  }

  const { allowedCalls, manifestTargets } = deriveAllowedSessionCalls(envelope, calls, budget)

  const tokenSpend: SessionSpendLimit = {
    token: envelope.paymentToken,
    period: spendWindow.period,
    periodCode: spendWindow.periodCode,
    limitBaseUnits: tokenCap.toString(),
  }
  const nativeSpend: SessionSpendLimit = {
    token: zeroAddress,
    period: spendWindow.period,
    periodCode: spendWindow.periodCode,
    limitBaseUnits: relayAllowance.toString(),
  }

  return {
    chainId: envelope.chainId,
    jobId: envelope.jobId,
    account: envelope.buyer,
    provider: envelope.provider,
    policy: envelope.policy,
    allowedCalls,
    tokenSpend,
    nativeSpend,
    expiryUnix,
    sessionStartUnix: options.nowUnix,
    jobExpiredAtUnix: envelope.expiredAtUnix,
    spendWindow,
    manifestTargets,
    permissions: {
      calls: allowedCalls.map((call) => ({ signature: call.selector, to: call.target })),
      spend: [
        { limit: tokenCap, period: spendWindow.period, token: envelope.paymentToken },
        { limit: relayAllowance, period: spendWindow.period },
      ],
    },
  }
}
