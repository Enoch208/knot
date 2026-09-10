#!/usr/bin/env node
import { getAddress, toFunctionSelector } from "viem"
import {
  MAXIMUM_RELAY_FEE_ALLOWANCE_WEI,
  SessionHireAuthorityError,
  deriveSessionHireAuthority,
  type SessionHireAuthority,
} from "../packages/authority/src/index.ts"
import { TESTNET } from "../packages/chain/src/manifest.ts"
import {
  createCommerceProbeReader,
  prepareHireEnvelope,
  verifyTestnetCommerce,
  type CommerceCompatibility,
  type PreparedHire,
} from "../packages/commerce/src/index.ts"
import { deriveJobId } from "../apps/api/src/hire-preparation.ts"

const RANGEPILOT_PROVIDER = "0xE4feD886b4b9062486d4663c6962E14473Bd7320"
const RANGEPILOT_AGENT_ID = "2297"
const BUYER = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
const PRICE_BASE_UNITS = "100000000000000000"
const PRICE_LABEL = "0.1 U (BSC testnet payment token, 18 decimals)"
const DESCRIPTION = "KNOT verified hire: RangePilot pinned PancakeSwap V3 range analysis"
const QUOTE_REFERENCE = "compose-session-hire-authority/rangepilot-0.1U"
const QUOTE_LIFETIME_SECONDS = 600

const KNOWN_SIGNATURES = [
  "createJob(address,address,uint256,string,address)",
  "registerJob(uint256,address)",
  "setBudget(uint256,uint256,bytes)",
  "approve(address,uint256)",
  "fund(uint256,uint256,bytes)",
] as const

const signatureFor = (selector: string): string | null =>
  KNOWN_SIGNATURES.find((candidate) => toFunctionSelector(candidate) === selector) ?? null

function fail(reason: string, detail: readonly string[]): never {
  process.stderr.write(`${JSON.stringify({ composed: false, broadcast: false, reason, detail }, null, 2)}\n`)
  process.exit(1)
}

const paymentToken = (): string => {
  const declared = TESTNET.contracts.find((contract) => contract.role === "paymentToken")
  if (!declared) fail("NO_PAYMENT_TOKEN", ["the pinned BSC testnet manifest declares no payment token"])
  return declared.address
}

const probeCompatibility = async (): Promise<CommerceCompatibility> => {
  const rpcUrl = process.env.KNOT_BSC_TESTNET_RPC_URL ?? TESTNET.rpcUrls[0]
  if (!rpcUrl) fail("NO_TESTNET_RPC", ["the pinned BSC testnet manifest declares no RPC url"])
  return verifyTestnetCommerce(createCommerceProbeReader(rpcUrl))
}

const plan = (
  compatibility: CommerceCompatibility,
  prepared: PreparedHire,
  authority: SessionHireAuthority,
): Record<string, unknown> => ({
  schemaVersion: "knot.session-hire-authority-plan/1",
  composedAtUtc: new Date().toISOString(),
  status: "DRY_RUN_PLAN_ONLY",
  broadcast: false,
  submitted: false,
  signed: false,
  privateKeyUsed: false,
  network: { name: "BSC testnet", chainId: authority.chainId },
  compatibility: {
    status: compatibility.status,
    writeAllowed: compatibility.writeAllowed,
    observedAtUtc: compatibility.observedAtUtc,
    blockNumber: compatibility.blockNumber,
    selectedPolicy: compatibility.selectedPolicy,
    reasons: compatibility.reasons,
  },
  hire: {
    agent: "RangePilot",
    agentId: RANGEPILOT_AGENT_ID,
    jobId: authority.jobId,
    buyerAccount: authority.account,
    provider: authority.provider,
    priceLabel: PRICE_LABEL,
    budgetBaseUnits: prepared.envelope.budgetBaseUnits,
    paymentToken: prepared.envelope.paymentToken,
    commerce: prepared.envelope.commerce,
    policy: prepared.envelope.policy,
    disputeWindowSeconds: prepared.envelope.disputeWindowSeconds,
    jobExpiredAtUnix: prepared.envelope.expiredAtUnix,
    jobExpiredAtUtc: new Date(prepared.envelope.expiredAtUnix * 1000).toISOString(),
    preparedCallCount: prepared.calls.length,
  },
  requestedSessionAuthority: {
    allowedCalls: authority.allowedCalls.map((call) => ({
      role: call.role,
      target: call.target,
      selector: call.selector,
      functionSignature: signatureFor(call.selector),
      preparedCallIndexes: call.callIndexes,
      valueWei: "0",
    })),
    tokenSpendPermissions: [
      {
        token: authority.tokenSpend.token,
        period: authority.tokenSpend.period,
        periodCode: authority.tokenSpend.periodCode,
        limitBaseUnits: authority.tokenSpend.limitBaseUnits,
        equalsHireBudget: authority.tokenSpend.limitBaseUnits === prepared.envelope.budgetBaseUnits,
      },
    ],
    nativeSpendLimits: [
      {
        asset: authority.nativeSpend.token,
        purpose: "relay fee only",
        period: authority.nativeSpend.period,
        periodCode: authority.nativeSpend.periodCode,
        limitWei: authority.nativeSpend.limitBaseUnits,
        ceilingWei: MAXIMUM_RELAY_FEE_ALLOWANCE_WEI.toString(),
      },
    ],
    expiryUnix: authority.expiryUnix,
    expiryUtc: new Date(authority.expiryUnix * 1000).toISOString(),
    expirySeconds: authority.expiryUnix - authority.sessionStartUnix,
    expiryOutlivesJob: authority.expiryUnix > authority.jobExpiredAtUnix,
    spendWindow: {
      period: authority.spendWindow.period,
      periodStartUnix: authority.spendWindow.periodStartUnix,
      periodEndUnix: authority.spendWindow.periodEndUnix,
      containsWholeSession:
        authority.spendWindow.periodStartUnix <= authority.sessionStartUnix &&
        authority.spendWindow.periodEndUnix > authority.expiryUnix,
    },
    manifestVerifiedTargets: authority.manifestTargets,
  },
  sdkGrantInput: {
    entrypoint: "grantSession(wallet, adminSigner, options, config) from @altananetwork/sdk@0.7.1",
    expiry: authority.expiryUnix,
    permissions: {
      calls: authority.permissions.calls,
      spend: authority.permissions.spend.map((permission) => ({
        limit: permission.limit.toString(),
        period: permission.period,
        ...(permission.token === undefined ? {} : { token: getAddress(permission.token) }),
      })),
    },
  },
  notPerformedByThisScript: [
    "no transaction was signed",
    "no transaction was submitted to any relay or RPC",
    "no private key or session signer was created or loaded",
    "no session key was granted, registered, or revoked",
    "no token approval or job funding occurred",
    "no evidence file was written; evidence is recorded only after a human executes this plan",
  ],
  humanExecutionStillRequired: [
    "an admin signer held by the account owner must call grantSession with exactly these permissions",
    "a session-signed execute must then submit the five prepared calls in order",
    "the grant, the funded job, and the revoke must be read back before any claim is published",
  ],
})

const compatibility = await probeCompatibility()
if (compatibility.status !== "VERIFIED" || !compatibility.writeAllowed) {
  fail(
    "COMMERCE_NOT_VERIFIED",
    compatibility.reasons.length > 0 ? compatibility.reasons : ["commerce compatibility was not verified"],
  )
}

const nowUnix = Math.floor(Date.now() / 1000)
const prepared = prepareHireEnvelope(compatibility, {
  jobId: deriveJobId(QUOTE_REFERENCE),
  provider: RANGEPILOT_PROVIDER,
  buyer: BUYER,
  description: DESCRIPTION,
  priceUnits: PRICE_BASE_UNITS,
  currency: paymentToken(),
  quoteExpiresAtUnix: nowUnix + QUOTE_LIFETIME_SECONDS,
  nowUnix,
})

try {
  const authority = deriveSessionHireAuthority(compatibility, prepared, { nowUnix })
  process.stdout.write(`${JSON.stringify(plan(compatibility, prepared, authority), null, 2)}\n`)
  process.stderr.write("composed a plan only: nothing was signed and nothing was submitted\n")
} catch (error) {
  if (error instanceof SessionHireAuthorityError) fail(error.code, [error.message])
  throw error
}
