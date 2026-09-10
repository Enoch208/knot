#!/usr/bin/env node
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ScanClient, normalizeAgent } from "../packages/discovery/src/index.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TARGET = join(ROOT, "apps", "web", "src", "directory.snapshot.json")

const KNOT_AGENT_IDS = new Set(["2295", "2297", "2298", "2299"])
const SAMPLE_SIZE = 48

export interface DirectoryEntry {
  agentId: string
  registry: string
  chainId: number
  ownerAddress: string
  name: string
  nameProvenance: string
  description: string
  indexVerified: boolean
  feedbackCount: number | null
  averageScore: number | null
  averageScoreProvenance: string
  knotVerified: boolean
}

export interface DirectoryAggregates {
  claimedNames: number
  indexVerified: number
  withAnyFeedback: number
  withAnyScore: number
  defaultScaffoldNames: number
  distinctOwners: number
}

export interface DirectorySnapshot {
  observedAtUtc: string
  requestUri: string
  chainId: number
  registeredTotal: number
  sampleSize: number
  coverageStatement: string
  aggregates: DirectoryAggregates
  entries: DirectoryEntry[]
}

export function summarise(entries: readonly DirectoryEntry[]): DirectoryAggregates {
  return {
    claimedNames: entries.filter((entry) => entry.nameProvenance === "CLAIMED").length,
    indexVerified: entries.filter((entry) => entry.indexVerified).length,
    withAnyFeedback: entries.filter((entry) => (entry.feedbackCount ?? 0) > 0).length,
    withAnyScore: entries.filter((entry) => entry.averageScore !== null).length,
    defaultScaffoldNames: entries.filter((entry) => /^studio-agent$/i.test(entry.name)).length,
    distinctOwners: new Set(entries.map((entry) => entry.ownerAddress.toLowerCase())).size,
  }
}

const COVERAGE =
  "This is one page of the ERC-8004 index, not an enumeration of the registry. KNOT has not called, validated, or hired the agents listed here except where marked KNOT-verified. Names and descriptions are publisher-supplied registry metadata and are labelled CLAIMED."

interface ProvenanceValue {
  value: unknown
  provenance: { label: string }
}

const labelOf = (field: ProvenanceValue): string => field.provenance.label
const textOf = (field: ProvenanceValue, fallback: string): string =>
  typeof field.value === "string" && field.value.length > 0 ? field.value : fallback
const numberOf = (field: ProvenanceValue): number | null =>
  typeof field.value === "number" ? field.value : null

export function toEntry(normalized: ReturnType<typeof normalizeAgent>): DirectoryEntry {
  return {
    agentId: normalized.key.agentId,
    registry: normalized.key.registry,
    chainId: normalized.key.chainId,
    ownerAddress: normalized.ownerAddress,
    name: textOf(normalized.name as ProvenanceValue, "unnamed"),
    nameProvenance: labelOf(normalized.name as ProvenanceValue),
    description: textOf(normalized.description as ProvenanceValue, "no description published"),
    indexVerified: normalized.indexVerified,
    feedbackCount: numberOf(normalized.feedbackCount as ProvenanceValue),
    averageScore: numberOf(normalized.averageScore as ProvenanceValue),
    averageScoreProvenance: labelOf(normalized.averageScore as ProvenanceValue),
    knotVerified: KNOT_AGENT_IDS.has(normalized.key.agentId),
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.KNOT_SCAN_API_KEY
  const client = new ScanClient(apiKey === undefined ? {} : { apiKey })
  const result = await client.listAgents({ chainId: 97, limit: SAMPLE_SIZE })

  const entries = result.page.items.map((item) =>
    toEntry(normalizeAgent(item, result.coverage.observedAtUtc, result.coverage.requestUri)),
  )

  const snapshot: DirectorySnapshot = {
    observedAtUtc: result.coverage.observedAtUtc,
    requestUri: result.coverage.requestUri,
    chainId: 97,
    registeredTotal: result.coverage.matchingTotal,
    sampleSize: entries.length,
    coverageStatement: COVERAGE,
    aggregates: summarise(entries),
    entries,
  }

  await writeFile(TARGET, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stderr.write(
    `[directory] sampled ${entries.length} of ${result.coverage.matchingTotal} registered on chain 97\n`,
  )
  process.stderr.write(`[directory] KNOT-verified in sample: ${entries.filter((e) => e.knotVerified).length}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
