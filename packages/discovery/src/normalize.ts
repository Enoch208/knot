import {
  claimed,
  live,
  unavailable,
  type LabeledValue,
} from "../../provenance/src/provenance.ts"
import type { ScanAgentItem } from "./types.ts"

export interface DiscoveredAgent {
  key: { chainId: 56 | 97; registry: `0x${string}`; agentId: string }
  isTestnet: boolean
  ownerAddress: `0x${string}`
  indexVerified: boolean
  name: LabeledValue<string>
  description: LabeledValue<string>
  supportedProtocols: LabeledValue<readonly string[]>
  x402Supported: LabeledValue<boolean>
  feedbackCount: LabeledValue<number>
  averageScore: LabeledValue<number>
  healthScore: LabeledValue<number>
  registeredAtUtc: LabeledValue<string>
  untrustedMetadata: Readonly<Record<string, unknown>>
}

const SOURCE_INDEX = "8004scan/api/v1/agents"
const SOURCE_PUBLISHER = "erc-8004 registry metadata"

const KNOWN_FIELDS = new Set([
  "agent_id",
  "token_id",
  "chain_id",
  "contract_address",
  "is_testnet",
  "owner_address",
  "name",
  "description",
  "is_verified",
  "supported_protocols",
  "x402_supported",
  "total_feedbacks",
  "average_score",
  "health_score",
  "created_at",
  "updated_at",
])

const isSupportedChain = (value: number): value is 56 | 97 => value === 56 || value === 97

function untrustedFields(item: ScanAgentItem): Readonly<Record<string, unknown>> {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = value
  }
  return Object.freeze(extra)
}

export class UnsupportedRegistryChainError extends Error {
  readonly observedChainId: number

  constructor(observedChainId: number) {
    super(`agent registry chain ${observedChainId} is outside the declared BSC manifest`)
    this.name = "UnsupportedRegistryChainError"
    this.observedChainId = observedChainId
  }
}

export function normalizeAgent(
  item: ScanAgentItem,
  observedAtUtc: string,
  requestUri: string,
): DiscoveredAgent {
  if (!isSupportedChain(item.chain_id)) throw new UnsupportedRegistryChainError(item.chain_id)

  const feedbackCount = item.total_feedbacks ?? 0
  const hasFeedback = feedbackCount > 0

  return {
    key: { chainId: item.chain_id, registry: item.contract_address, agentId: item.token_id },
    isTestnet: item.is_testnet,
    ownerAddress: item.owner_address,
    indexVerified: item.is_verified,
    name:
      item.name === null || item.name.trim() === ""
        ? unavailable(SOURCE_PUBLISHER, "the registry metadata declares no name", observedAtUtc)
        : claimed(item.name, SOURCE_PUBLISHER, observedAtUtc, requestUri),
    description:
      item.description === null || item.description.trim() === ""
        ? unavailable(
            SOURCE_PUBLISHER,
            "the registry metadata declares no description",
            observedAtUtc,
          )
        : claimed(item.description, SOURCE_PUBLISHER, observedAtUtc, requestUri),
    supportedProtocols:
      item.supported_protocols === null
        ? unavailable(SOURCE_PUBLISHER, "no protocol list is published", observedAtUtc)
        : claimed(Object.freeze([...item.supported_protocols]), SOURCE_PUBLISHER, observedAtUtc),
    x402Supported:
      item.x402_supported === null
        ? unavailable(SOURCE_INDEX, "the index reports no x402 support flag", observedAtUtc)
        : live(item.x402_supported, SOURCE_INDEX, observedAtUtc, requestUri),
    feedbackCount: live(feedbackCount, SOURCE_INDEX, observedAtUtc, requestUri),
    averageScore: hasFeedback
      ? item.average_score === null
        ? unavailable(SOURCE_INDEX, "the index reports no average score", observedAtUtc)
        : live(item.average_score, SOURCE_INDEX, observedAtUtc, requestUri)
      : unavailable(SOURCE_INDEX, "no feedback has been recorded for this agent", observedAtUtc),
    healthScore:
      item.health_score === null
        ? unavailable(SOURCE_INDEX, "the index reports no health score", observedAtUtc)
        : live(item.health_score, SOURCE_INDEX, observedAtUtc, requestUri),
    registeredAtUtc:
      item.created_at === null
        ? unavailable(SOURCE_INDEX, "the index reports no registration time", observedAtUtc)
        : live(item.created_at, SOURCE_INDEX, observedAtUtc, requestUri),
    untrustedMetadata: untrustedFields(item),
  }
}
