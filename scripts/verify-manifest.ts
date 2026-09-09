#!/usr/bin/env node
import { createPublicClient, http, keccak256, type PublicClient } from "viem"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ERC1967_ADMIN_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  MANIFESTS,
  type ChainId,
  type DeclaredContract,
  type IntegrationStatus,
  type NetworkManifest,
} from "../packages/chain/src/manifest.ts"
import {
  createCommerceProbeReader,
  verifyTestnetCommerce,
  type CommerceCompatibility,
  type CommerceProbeReader,
} from "../packages/commerce/src/index.ts"

interface ContractObservation {
  role: string
  address: string
  status: IntegrationStatus
  codeHash: string | null
  codeSize: number
  implementation: string | null
  implementationCodeHash: string | null
  proxyAdmin: string | null
  note?: string
}

interface NetworkObservation {
  chainId: ChainId
  label: string
  rpcUrl: string
  blockNumber: string
  observedAtUtc: string
  writesPermitted: boolean
  contracts: ContractObservation[]
  commerceCompatibility: CommerceCompatibility | null
  suspensions: string[]
}

const ZERO_WORD = `0x${"0".repeat(64)}`
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "manifests")

type CommerceReaderFactory = (rpcUrl: string) => CommerceProbeReader

const commerceWritesVerified = (compatibility: CommerceCompatibility | null): boolean =>
  compatibility?.status === "VERIFIED" &&
  compatibility.writeAllowed &&
  compatibility.selectedPolicy !== null

export async function probeTestnetCommerce(
  rpcUrl: string,
  observedAtUtc: string,
  createReader: CommerceReaderFactory = createCommerceProbeReader,
): Promise<CommerceCompatibility> {
  try {
    return await verifyTestnetCommerce(createReader(rpcUrl), observedAtUtc)
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
      reasons: [`compatibility reader failed: ${error instanceof Error ? error.message : String(error)}`],
      policies: [],
    }
  }
}

export function commerceCompatibilitySuspensions(
  compatibility: CommerceCompatibility | null,
): string[] {
  if (!compatibility) return ["commerce: compatibility probe unavailable"]
  if (commerceWritesVerified(compatibility)) return []
  const reasons = compatibility.reasons.length > 0
    ? compatibility.reasons
    : ["compatibility probe did not permit writes"]
  return reasons.map((reason) => `commerce: ${reason}`)
}

export function permitsNetworkWrites(
  writeEnabled: boolean,
  compatibility: CommerceCompatibility | null,
  suspensions: readonly string[],
): boolean {
  return writeEnabled && commerceWritesVerified(compatibility) && suspensions.length === 0
}

const wordToAddress = (word: string | undefined): string | null =>
  word && word !== ZERO_WORD ? `0x${word.slice(26)}` : null

async function connect(manifest: NetworkManifest): Promise<{ client: PublicClient; rpcUrl: string }> {
  const failures: string[] = []
  for (const rpcUrl of manifest.rpcUrls) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) }) as PublicClient
      const observed = await client.getChainId()
      if (observed !== manifest.chainId) {
        failures.push(`${rpcUrl} reports chain ${observed}`)
        continue
      }
      return { client, rpcUrl }
    } catch (error) {
      failures.push(`${rpcUrl} unreachable: ${(error as Error).message.split("\n")[0]}`)
    }
  }
  throw new Error(`no usable RPC for chain ${manifest.chainId}: ${failures.join("; ")}`)
}

async function observeContract(
  client: PublicClient,
  declared: DeclaredContract,
  writeEnabled: boolean,
): Promise<ContractObservation> {
  const code = await client.getCode({ address: declared.address })
  const codeSize = code && code !== "0x" ? (code.length - 2) / 2 : 0

  if (codeSize === 0) {
    return {
      role: declared.role,
      address: declared.address,
      status: "UNRESOLVED",
      codeHash: null,
      codeSize: 0,
      implementation: null,
      implementationCodeHash: null,
      proxyAdmin: null,
      note: "no bytecode at declared address",
    }
  }

  const isProxyStub = codeSize <= 200
  let implementation: string | null = null
  let implementationCodeHash: string | null = null
  let proxyAdmin: string | null = null

  if (isProxyStub) {
    const [implWord, adminWord] = await Promise.all([
      client.getStorageAt({ address: declared.address, slot: ERC1967_IMPLEMENTATION_SLOT }),
      client.getStorageAt({ address: declared.address, slot: ERC1967_ADMIN_SLOT }),
    ])
    implementation = wordToAddress(implWord)
    proxyAdmin = wordToAddress(adminWord)
    if (implementation) {
      const implCode = await client.getCode({ address: implementation as `0x${string}` })
      implementationCodeHash = implCode && implCode !== "0x" ? keccak256(implCode) : null
    }
  }

  const missingImplementation = isProxyStub && implementationCodeHash === null

  let status: IntegrationStatus = writeEnabled ? "VERIFIED" : "READ_ONLY"
  let note: string | undefined
  if (missingImplementation) {
    status = "UNRESOLVED"
    note = "proxy stub with no readable ERC-1967 implementation"
  }

  return {
    role: declared.role,
    address: declared.address,
    status,
    codeHash: keccak256(code as `0x${string}`),
    codeSize,
    implementation,
    implementationCodeHash,
    proxyAdmin,
    ...(note === undefined ? {} : { note }),
  }
}

async function detectDrift(observation: NetworkObservation): Promise<string[]> {
  const path = join(OUT_DIR, `network-${observation.chainId}.json`)
  let previous: NetworkObservation
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as NetworkObservation
  } catch {
    return []
  }
  const drift: string[] = []
  for (const current of observation.contracts) {
    const before = previous.contracts.find((entry) => entry.role === current.role)
    if (!before) continue
    if (before.codeHash !== current.codeHash) {
      drift.push(`${current.role}: bytecode changed since ${previous.observedAtUtc}`)
    }
    if (before.implementationCodeHash !== current.implementationCodeHash) {
      drift.push(`${current.role}: proxy implementation changed since ${previous.observedAtUtc}`)
    }
  }
  return drift
}

async function verifyNetwork(chainId: ChainId): Promise<NetworkObservation> {
  const manifest = MANIFESTS[chainId]
  const { client, rpcUrl } = await connect(manifest)
  const blockNumber = await client.getBlockNumber()
  const observedAtUtc = new Date().toISOString()

  const contracts: ContractObservation[] = []
  for (const declared of manifest.contracts) {
    contracts.push(await observeContract(client, declared, manifest.writeEnabled))
  }
  const commerceCompatibility = chainId === 97
    ? await probeTestnetCommerce(rpcUrl, observedAtUtc)
    : null

  const observation: NetworkObservation = {
    chainId,
    label: manifest.label,
    rpcUrl,
    blockNumber: blockNumber.toString(),
    observedAtUtc,
    writesPermitted: false,
    contracts,
    commerceCompatibility,
    suspensions: [],
  }

  const drift = await detectDrift(observation)
  const unresolved = contracts.filter((entry) => entry.status === "UNRESOLVED")
  observation.suspensions = [
    ...drift,
    ...unresolved.map((entry) => `${entry.role}: ${entry.note ?? "unresolved"}`),
    ...(chainId === 97 ? commerceCompatibilitySuspensions(commerceCompatibility) : []),
  ]
  observation.writesPermitted = permitsNetworkWrites(
    manifest.writeEnabled,
    commerceCompatibility,
    observation.suspensions,
  )

  return observation
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  let failed = false

  for (const chainId of [56, 97] as const) {
    const observation = await verifyNetwork(chainId)
    await writeFile(
      join(OUT_DIR, `network-${chainId}.json`),
      `${JSON.stringify(observation, null, 2)}\n`,
    )

    process.stderr.write(`\n${observation.label} (${chainId}) block ${observation.blockNumber}\n`)
    process.stderr.write(`  rpc ${observation.rpcUrl}\n`)
    for (const contract of observation.contracts) {
      const implNote = contract.implementation ? ` impl ${contract.implementation}` : ""
      process.stderr.write(
        `  ${contract.role.padEnd(13)} ${contract.status.padEnd(10)} ${contract.address}${implNote}\n`,
      )
      if (contract.note) process.stderr.write(`  ${" ".repeat(13)} ${contract.note}\n`)
    }
    if (observation.commerceCompatibility) {
      const commerce = observation.commerceCompatibility
      process.stderr.write(
        `  commerce probe ${commerce.status} at block ${commerce.blockNumber ?? "unknown"}` +
          `${commerce.selectedPolicy ? ` policy ${commerce.selectedPolicy}` : ""}\n`,
      )
    }
    process.stderr.write(
      `  writes ${observation.writesPermitted ? "PERMITTED" : "SUSPENDED"}${
        observation.suspensions.length > 0 ? ` (${observation.suspensions.length} reason(s))` : ""
      }\n`,
    )
    if (MANIFESTS[chainId].writeEnabled && !observation.writesPermitted) failed = true
  }

  if (failed) {
    process.stderr.write("\nwrite-enabled network has unresolved integrations; writes stay disabled\n")
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) await main()
