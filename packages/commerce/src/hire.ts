import { buildHireCalls, type Call } from "@altananetwork/sdk"
import { getAddress, type Address } from "viem"
import { requireCommerceWriteReady, type CommerceCompatibility } from "./compatibility.ts"
import { resolveTestnetSdkSource } from "./deployments.ts"

export interface PrepareHireInput {
  jobId: bigint
  provider: Address
  description: string
  budget: bigint
  expiredAt: bigint
  nowSeconds?: bigint
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export function prepareHire(
  compatibility: CommerceCompatibility,
  input: PrepareHireInput,
): Call[] {
  const policy = requireCommerceWriteReady(compatibility)
  const provider = getAddress(input.provider)
  if (input.jobId <= 0n) throw new Error("jobId must be positive")
  if (provider === ZERO_ADDRESS) throw new Error("provider must not be the zero address")
  if (input.budget <= 0n) throw new Error("paid hire budget must be positive")
  const policyObservation = compatibility.policies.find(
    (candidate) => candidate.address.toLowerCase() === policy.toLowerCase(),
  )
  if (!policyObservation) throw new Error("selected policy has no compatibility observation")
  const nowSeconds = input.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000))
  const earliestExpiry = nowSeconds + BigInt(policyObservation.disputeWindowSeconds)
  if (input.expiredAt <= earliestExpiry) {
    throw new Error(`expiredAt must exceed ${earliestExpiry} for the selected policy`)
  }
  const deployment = resolveTestnetSdkSource("@bnbagent/sdk").deployment
  return buildHireCalls({
    addresses: {
      commerce: deployment.commerce,
      router: deployment.router,
      policy,
      registry: deployment.registry,
      paymentToken: deployment.paymentToken,
    },
    jobId: input.jobId,
    provider,
    description: input.description,
    budget: input.budget,
    expiredAt: input.expiredAt,
  })
}
