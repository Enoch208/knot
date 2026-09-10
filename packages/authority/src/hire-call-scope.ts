import { decodeFunctionData, getAddress, size, slice, toFunctionSelector, type Address, type Hex } from "viem"
import { MANIFESTS, type ContractRole } from "../../chain/src/manifest.ts"
import type { HireEnvelope, PreparedCall } from "../../commerce/src/hire-envelope.ts"
import { refuse } from "./errors.ts"

export const ANY_TARGET_SENTINEL = "0x3232323232323232323232323232323232323232"
export const ANY_SELECTOR_SENTINEL = "0x32323232"
export const EMPTY_CALLDATA_SELECTOR = "0xe0e0e0e0"

const APPROVE_SIGNATURE = "approve(address,uint256)"
const FUND_SIGNATURE = "fund(uint256,uint256,bytes)"

const APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

const FUND_ABI = [
  {
    name: "fund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "expectedBudget", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
] as const

export interface ManifestTarget {
  role: ContractRole
  address: Address
}

export interface AllowedSessionCall {
  target: Address
  role: ContractRole
  selector: Hex
  callIndexes: readonly number[]
}

const manifestTargets = (): readonly ManifestTarget[] =>
  MANIFESTS[97].contracts.map((contract) => ({ role: contract.role, address: getAddress(contract.address) }))

const roleOf = (targets: readonly ManifestTarget[], address: Address): ContractRole | null =>
  targets.find((candidate) => candidate.address === address)?.role ?? null

const requireEnvelopeOnManifest = (targets: readonly ManifestTarget[], envelope: HireEnvelope): void => {
  const declared: readonly [ContractRole, Address][] = [
    ["commerce", envelope.commerce],
    ["policy", envelope.policy],
    ["paymentToken", envelope.paymentToken],
  ]
  for (const [role, address] of declared) {
    const manifest = targets.find((candidate) => candidate.role === role)
    if (!manifest || manifest.address !== getAddress(address)) {
      refuse(
        "ENVELOPE_CONTRACT_OFF_MANIFEST",
        `envelope ${role} ${address} is not the pinned BSC testnet manifest address`,
      )
    }
  }
}

const selectorOf = (call: PreparedCall, index: number): Hex => {
  if (size(call.data) < 4) {
    refuse("SELECTOR_MISSING", `prepared call ${index} carries no four-byte selector`)
  }
  const selector = slice(call.data, 0, 4)
  if (selector.toLowerCase() === ANY_SELECTOR_SENTINEL) {
    refuse("WILDCARD_SELECTOR", `prepared call ${index} uses the any-function sentinel ${ANY_SELECTOR_SENTINEL}`)
  }
  if (selector.toLowerCase() === EMPTY_CALLDATA_SELECTOR) {
    refuse("EMPTY_CALLDATA_SELECTOR", `prepared call ${index} uses the empty-calldata sentinel`)
  }
  return selector
}

const targetOf = (
  targets: readonly ManifestTarget[],
  call: PreparedCall,
  index: number,
): { target: Address; role: ContractRole } => {
  const target = getAddress(call.to)
  if (target.toLowerCase() === ANY_TARGET_SENTINEL) {
    refuse("WILDCARD_TARGET", `prepared call ${index} targets the any-target sentinel ${ANY_TARGET_SENTINEL}`)
  }
  const role = roleOf(targets, target)
  if (role === null) {
    refuse("TARGET_OUTSIDE_MANIFEST", `prepared call ${index} targets ${target}, which no pinned manifest role declares`)
  }
  return { target, role }
}

const requireBoundedApproval = (
  calls: readonly PreparedCall[],
  selectors: readonly Hex[],
  envelope: HireEnvelope,
  budget: bigint,
): void => {
  const matches = calls.filter((call) => getAddress(call.to) === getAddress(envelope.paymentToken))
  const call = matches[0]
  if (matches.length !== 1 || call === undefined) {
    refuse(
      "TOKEN_CALL_COUNT_UNEXPECTED",
      `a spend-scoped hire must touch the payment token exactly once, observed ${matches.length}`,
    )
  }
  const index = calls.indexOf(call)
  if (selectors[index] !== toFunctionSelector(APPROVE_SIGNATURE)) {
    refuse("TOKEN_CALL_NOT_APPROVAL", `payment-token call ${index} is not ${APPROVE_SIGNATURE}`)
  }
  const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: call.data })
  const [spender, amount] = decoded.args
  if (getAddress(spender) !== getAddress(envelope.commerce)) {
    refuse("APPROVAL_SPENDER_NOT_COMMERCE", `the approval names ${spender} rather than the commerce kernel`)
  }
  if (amount !== budget) {
    refuse("APPROVAL_AMOUNT_NOT_BUDGET", `the approval allows ${amount} base units rather than the ${budget} budget`)
  }
}

const requireBoundedFunding = (
  calls: readonly PreparedCall[],
  selectors: readonly Hex[],
  envelope: HireEnvelope,
  budget: bigint,
): void => {
  const indexes = selectors
    .map((selector, index) => ({ selector, index }))
    .filter((entry) => entry.selector === toFunctionSelector(FUND_SIGNATURE))
    .map((entry) => entry.index)
  const index = indexes[0]
  const call = index === undefined ? undefined : calls[index]
  if (indexes.length !== 1 || call === undefined) {
    refuse("FUND_CALL_COUNT_UNEXPECTED", `a spend-scoped hire must fund exactly once, observed ${indexes.length}`)
  }
  const decoded = decodeFunctionData({ abi: FUND_ABI, data: call.data })
  const [jobId, expectedBudget] = decoded.args
  if (jobId !== BigInt(envelope.jobId)) {
    refuse("FUND_JOB_ID_MISMATCH", `the funding call names job ${jobId} rather than ${envelope.jobId}`)
  }
  if (expectedBudget !== budget) {
    refuse("FUND_AMOUNT_NOT_BUDGET", `the funding call moves ${expectedBudget} base units rather than ${budget}`)
  }
}

export function deriveAllowedSessionCalls(
  envelope: HireEnvelope,
  calls: readonly PreparedCall[],
  budget: bigint,
): { allowedCalls: readonly AllowedSessionCall[]; manifestTargets: readonly ManifestTarget[] } {
  const targets = manifestTargets()
  requireEnvelopeOnManifest(targets, envelope)
  if (calls.length === 0) refuse("NO_CALLS_TO_SCOPE", "a prepared hire with no calls cannot scope a session")
  if (calls.length !== envelope.callCount) {
    refuse(
      "CALL_COUNT_MISMATCH",
      `the envelope declares ${envelope.callCount} calls but ${calls.length} were prepared`,
    )
  }

  const selectors: Hex[] = []
  const scoped = new Map<string, AllowedSessionCall>()
  calls.forEach((call, index) => {
    if (call.value !== "0") {
      refuse("CALL_CARRIES_NATIVE_VALUE", `prepared call ${index} sends ${call.value} wei; a hire moves only tokens`)
    }
    const selector = selectorOf(call, index)
    const { target, role } = targetOf(targets, call, index)
    selectors.push(selector)
    const key = `${target}:${selector}`
    const existing = scoped.get(key)
    scoped.set(key, {
      target,
      role,
      selector,
      callIndexes: existing ? [...existing.callIndexes, index] : [index],
    })
  })

  requireBoundedApproval(calls, selectors, envelope, budget)
  requireBoundedFunding(calls, selectors, envelope, budget)

  return { allowedCalls: [...scoped.values()], manifestTargets: targets }
}
