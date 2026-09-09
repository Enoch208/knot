import { getAddress, type Address, type Hex } from "viem"
import {
  readInstalledSdkVersions,
  TESTNET_CODE_SNAPSHOT,
  TESTNET_SDK_SOURCES,
  type InstalledSdkVersions,
} from "./deployments.ts"
import type { CommerceProbeReader } from "./reader.ts"

export interface PolicyObservation {
  address: Address
  declaredBy: string[]
  codeHash: Hex | null
  whitelisted: boolean
  commerce: Address
  router: Address
  disputeWindowSeconds: string
  compatible: boolean
}

export interface CommerceCompatibility {
  status: "VERIFIED" | "UNRESOLVED"
  writeAllowed: boolean
  chainId: number | null
  blockNumber: string | null
  observedAtUtc: string
  sdkVersions: InstalledSdkVersions | null
  selectedPolicy: Address | null
  declarationConflict: boolean
  reasons: string[]
  policies: PolicyObservation[]
}

const sameAddress = (left: Address, right: Address): boolean =>
  left.toLowerCase() === right.toLowerCase()

export async function verifyTestnetCommerce(
  reader: CommerceProbeReader,
  observedAtUtc = new Date().toISOString(),
): Promise<CommerceCompatibility> {
  try {
    return await inspectTestnetCommerce(reader, observedAtUtc)
  } catch (error) {
    return {
      status: "UNRESOLVED",
      writeAllowed: false,
      chainId: null,
      blockNumber: null,
      observedAtUtc,
      sdkVersions: null,
      selectedPolicy: null,
      declarationConflict: true,
      reasons: [`compatibility probe failed: ${error instanceof Error ? error.message : String(error)}`],
      policies: [],
    }
  }
}

async function inspectTestnetCommerce(
  reader: CommerceProbeReader,
  observedAtUtc: string,
): Promise<CommerceCompatibility> {
  const [altana, bnbAgent] = TESTNET_SDK_SOURCES
  const expected = bnbAgent.deployment
  const sdkVersions = await readInstalledSdkVersions()
  const chainId = await reader.chainId()
  const blockNumber = await reader.blockNumber()
  const reasons: string[] = []
  for (const source of TESTNET_SDK_SOURCES) {
    if (sdkVersions[source.packageName] !== source.version) {
      reasons.push(`${source.packageName} version ${sdkVersions[source.packageName]} does not match ${source.version}`)
    }
  }
  if (chainId !== TESTNET_CODE_SNAPSHOT.chainId) reasons.push(`RPC chain ${chainId} is not BSC testnet 97`)
  if (blockNumber < TESTNET_CODE_SNAPSHOT.blockNumber) reasons.push("RPC is behind the pinned compatibility block")

  for (const field of ["commerce", "router", "registry", "paymentToken"] as const) {
    if (!sameAddress(altana.deployment[field], bnbAgent.deployment[field])) {
      reasons.push(`SDK declarations disagree on ${field}`)
    }
  }

  const codeChecks = [
    ["commerce", expected.commerce, TESTNET_CODE_SNAPSHOT.hashes.commerce],
    ["commerce implementation", expected.commerceImplementation, TESTNET_CODE_SNAPSHOT.hashes.commerceImplementation],
    ["router", expected.router, TESTNET_CODE_SNAPSHOT.hashes.router],
    ["router implementation", expected.routerImplementation, TESTNET_CODE_SNAPSHOT.hashes.routerImplementation],
    ["registry", expected.registry, TESTNET_CODE_SNAPSHOT.hashes.registry],
    ["registry implementation", expected.registryImplementation, TESTNET_CODE_SNAPSHOT.hashes.registryImplementation],
    ["payment token", expected.paymentToken, TESTNET_CODE_SNAPSHOT.hashes.paymentToken],
  ] as const
  for (const [label, contract, expectedHash] of codeChecks) {
    if ((await reader.codeHash(contract)) !== expectedHash) reasons.push(`${label} bytecode differs from the pinned snapshot`)
  }

  const [commerceImplementation, routerImplementation, registryImplementation] = await Promise.all([
    reader.implementation(expected.commerce),
    reader.implementation(expected.router),
    reader.implementation(expected.registry),
  ])
  if (!commerceImplementation || !sameAddress(commerceImplementation, expected.commerceImplementation)) {
    reasons.push("commerce proxy implementation differs from the pinned deployment")
  }
  if (!routerImplementation || !sameAddress(routerImplementation, expected.routerImplementation)) {
    reasons.push("router proxy implementation differs from the pinned deployment")
  }
  if (!registryImplementation || !sameAddress(registryImplementation, expected.registryImplementation)) {
    reasons.push("registry proxy implementation differs from the pinned deployment")
  }

  const [routerCommerce, routerPaused, paymentToken] = await Promise.all([
    reader.routerCommerce(expected.router),
    reader.routerPaused(expected.router),
    reader.paymentToken(expected.commerce),
  ])
  if (!sameAddress(routerCommerce, expected.commerce)) reasons.push("router is bound to a different commerce kernel")
  if (routerPaused) reasons.push("router is paused")
  if (!sameAddress(paymentToken, expected.paymentToken)) reasons.push("commerce payment token differs from the SDK deployment")

  const candidates = [...new Set(TESTNET_SDK_SOURCES.map((source) => source.deployment.policy.toLowerCase()))]
  const policies: PolicyObservation[] = []
  for (const normalized of candidates) {
    const policy = getAddress(normalized)
    const [codeHash, whitelisted, commerce, router, disputeWindow] = await Promise.all([
      reader.codeHash(policy),
      reader.policyWhitelisted(expected.router, policy),
      reader.policyCommerce(policy),
      reader.policyRouter(policy),
      reader.disputeWindow(policy),
    ])
    const expectedHash = sameAddress(policy, altana.deployment.policy)
      ? TESTNET_CODE_SNAPSHOT.hashes.altanaPolicy
      : TESTNET_CODE_SNAPSHOT.hashes.bnbAgentPolicy
    const compatible =
      codeHash === expectedHash &&
      whitelisted &&
      sameAddress(commerce, expected.commerce) &&
      sameAddress(router, expected.router) &&
      disputeWindow > 0n
    policies.push({
      address: policy,
      declaredBy: TESTNET_SDK_SOURCES.filter((source) => sameAddress(source.deployment.policy, policy)).map(
        (source) => `${source.packageName}@${source.version}`,
      ),
      codeHash,
      whitelisted,
      commerce,
      router,
      disputeWindowSeconds: disputeWindow.toString(),
      compatible,
    })
  }
  const compatiblePolicies = policies.filter((policy) => policy.compatible)
  if (compatiblePolicies.length !== 1) {
    reasons.push(`expected exactly one live compatible policy, observed ${compatiblePolicies.length}`)
  }
  const selectedPolicy = compatiblePolicies[0]?.address ?? null
  const writeAllowed = reasons.length === 0 && selectedPolicy !== null
  return {
    status: writeAllowed ? "VERIFIED" : "UNRESOLVED",
    writeAllowed,
    chainId,
    blockNumber: blockNumber.toString(),
    observedAtUtc,
    sdkVersions,
    selectedPolicy,
    declarationConflict: !sameAddress(altana.deployment.policy, bnbAgent.deployment.policy),
    reasons,
    policies,
  }
}

export function requireCommerceWriteReady(observation: CommerceCompatibility): Address {
  if (!observation.writeAllowed || observation.status !== "VERIFIED" || !observation.selectedPolicy) {
    const reason = observation.reasons.join("; ") || "compatibility was not verified"
    throw new Error(`ERC-8183 writes are suspended: ${reason}`)
  }
  return observation.selectedPolicy
}
