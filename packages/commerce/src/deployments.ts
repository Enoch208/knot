import { ERC8183_ADDRESSES } from "@altananetwork/sdk"
import { NETWORKS } from "@bnbagent/sdk"
import { BNB_CHAIN_ADDRESSES } from "@bnbagent/sdk/networks"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getAddress, type Address, type Hex } from "viem"

export interface CommerceDeployment {
  commerce: Address
  commerceImplementation: Address
  router: Address
  routerImplementation: Address
  policy: Address
  registry: Address
  registryImplementation: Address
  paymentToken: Address
}

export interface SdkDeploymentSource {
  packageName: "@altananetwork/sdk" | "@bnbagent/sdk"
  version: "0.7.1" | "0.5.5"
  deployment: CommerceDeployment
}

export interface InstalledSdkVersions {
  "@altananetwork/sdk": string
  "@bnbagent/sdk": string
}

export type TestnetSdkPackageName = keyof InstalledSdkVersions

const TESTNET_CHAIN_ID = 97
const altana = ERC8183_ADDRESSES[TESTNET_CHAIN_ID]
const bnbNetwork = NETWORKS["bsc-testnet"]
const bnbAddresses = BNB_CHAIN_ADDRESSES[TESTNET_CHAIN_ID]

if (!altana || !bnbNetwork || !bnbAddresses) {
  throw new Error("pinned SDKs do not expose a BSC testnet deployment")
}

const address = (value: string): Address => getAddress(value)

const commonImplementations = {
  commerceImplementation: address(bnbAddresses.commerceImpl),
  routerImplementation: address(bnbAddresses.routerImpl),
  registryImplementation: address("0x7274e874ca62410a93bd8bf61c69d8045e399c02"),
}

export const TESTNET_SDK_SOURCES: readonly [SdkDeploymentSource, SdkDeploymentSource] = [
  {
    packageName: "@altananetwork/sdk",
    version: "0.7.1",
    deployment: {
      commerce: address(altana.commerce),
      router: address(altana.router),
      policy: address(altana.policy),
      registry: address(altana.registry),
      paymentToken: address(altana.paymentToken),
      ...commonImplementations,
    },
  },
  {
    packageName: "@bnbagent/sdk",
    version: "0.5.5",
    deployment: {
      commerce: address(bnbNetwork.commerceContract),
      router: address(bnbNetwork.routerContract),
      policy: address(bnbNetwork.policyContract),
      registry: address(bnbNetwork.registryContract),
      paymentToken: address(bnbAddresses.paymentToken),
      ...commonImplementations,
    },
  },
]

export function resolveTestnetSdkSource(packageName: TestnetSdkPackageName): SdkDeploymentSource {
  const matches = TESTNET_SDK_SOURCES.filter((source) => source.packageName === packageName)
  const source = matches[0]
  if (matches.length !== 1 || !source) {
    throw new Error(`expected exactly one BSC testnet deployment from ${packageName}`)
  }
  return source
}

export const TESTNET_CODE_SNAPSHOT = {
  chainId: TESTNET_CHAIN_ID,
  blockNumber: 129987120n,
  observedAtUtc: "2026-09-09T07:59:06Z",
  hashes: {
    commerce: "0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89",
    commerceImplementation: "0x949f04b966cde30955d1daca5bf8605eed67db9ddc2b1cf86ac018bf3bf2e08f",
    router: "0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89",
    routerImplementation: "0xb523939a51d980e6bb482b6362806d06b2d75cee4e230d4ccb25f9acf0e44d18",
    altanaPolicy: "0x10b1f9306d2a03557471d90a8624e7f758757b736b44d1e25ef3eba83ed96812",
    bnbAgentPolicy: "0xe06798700c986d4387898a1dfde009d52c75f77c7d8dd1a3e179c02d5138cb9b",
    registry: "0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41",
    registryImplementation: "0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f",
    paymentToken: "0xae12b1d61f7ed4febf649ccf319cb49a0e921cca3739dcb01b47d316049d46ff",
  } satisfies Record<string, Hex>,
} as const

async function installedVersion(packageName: keyof InstalledSdkVersions): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve(packageName))
  const parsed: unknown = JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error(`${packageName} package metadata has no version`)
  }
  return parsed.version
}

export async function readInstalledSdkVersions(): Promise<InstalledSdkVersions> {
  const [altanaVersion, bnbAgentVersion] = await Promise.all([
    installedVersion("@altananetwork/sdk"),
    installedVersion("@bnbagent/sdk"),
  ])
  return { "@altananetwork/sdk": altanaVersion, "@bnbagent/sdk": bnbAgentVersion }
}
