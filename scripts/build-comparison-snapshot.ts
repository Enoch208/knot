#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  compareCandidates,
  type Candidate,
  type TaskComparison,
} from "../packages/comparison/src/task-comparison.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TESTNET = join(ROOT, "evidence", "testnet")
const TARGET = join(ROOT, "apps", "web", "src", "comparison.snapshot.json")

export interface ComparisonSnapshot {
  observationsThroughUtc: string
  categories: ReadonlyArray<{
    key: string
    label: string
    candidates: Candidate[]
    comparison: TaskComparison
  }>
}

const KNOT_CANDIDATES: ReadonlyArray<Candidate & { categoryKey: string }> = [
  {
    categoryKey: "health",
    key: "healthguard",
    displayName: "HealthGuard",
    category: "health",
    operatorRelationship: "KNOT_OPERATED",
    availability: "CALLABLE",
    priceBaseUnits: "100000000000000000",
    currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    quoteExpiresAtUnix: null,
    completedJobs: 1,
    refundedJobs: 1,
    evidenceClass: "testnet_observation",
  },
  {
    categoryKey: "rebalancing",
    key: "rangepilot",
    displayName: "RangePilot",
    category: "rebalancing",
    operatorRelationship: "KNOT_OPERATED",
    availability: "CALLABLE",
    priceBaseUnits: "100000000000000000",
    currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    quoteExpiresAtUnix: null,
    completedJobs: 1,
    refundedJobs: 0,
    evidenceClass: "testnet_observation",
  },
  {
    categoryKey: "grid",
    key: "gridquant",
    displayName: "GridQuant",
    category: "grid",
    operatorRelationship: "KNOT_OPERATED",
    availability: "CALLABLE",
    priceBaseUnits: "100000000000000000",
    currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    quoteExpiresAtUnix: null,
    completedJobs: 1,
    refundedJobs: 0,
    evidenceClass: "testnet_observation",
  },
  {
    categoryKey: "yield",
    key: "yieldscout",
    displayName: "YieldScout",
    category: "yield",
    operatorRelationship: "KNOT_OPERATED",
    availability: "CALLABLE",
    priceBaseUnits: "100000000000000000",
    currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    quoteExpiresAtUnix: null,
    completedJobs: 1,
    refundedJobs: 0,
    evidenceClass: "testnet_observation",
  },
]

const CATEGORY_LABELS: Record<string, string> = {
  health: "Lending health",
  rebalancing: "LP range management",
  grid: "Grid strategy",
  yield: "Yield comparison",
}

interface ExternalJob {
  identity: { agentId: string; name: string; provider: string }
  outcome: { deliveryReceived?: unknown; reason?: unknown }
  network?: { contracts?: { paymentToken?: unknown } }
  expectedPriceBaseUnits?: unknown
  taskDescription?: unknown
  capturedAtUtc?: unknown
}

export class ExternalCandidateSourceError extends Error {}

const categoryFor = (job: ExternalJob): string => {
  const description = typeof job.taskDescription === "string" ? job.taskDescription : ""
  if (/\bgrid\b/i.test(description)) return "grid"
  if (/pancakeswap v3 position|lp range|range/i.test(description)) return "rebalancing"
  throw new ExternalCandidateSourceError(
    `cannot classify external job for ${job.identity.agentId} from its recorded task description`,
  )
}

export async function readExternalCandidates(): Promise<{
  candidates: Array<Candidate & { categoryKey: string }>
  latestObservationUtc: string
}> {
  const names = (await readdir(TESTNET)).filter((name) => name.startsWith("external-paid-job-"))
  const candidates: Array<Candidate & { categoryKey: string }> = []
  let latest = ""

  for (const name of names.sort()) {
    const job = JSON.parse(await readFile(join(TESTNET, name), "utf8")) as ExternalJob
    const observed = typeof job.capturedAtUtc === "string" ? job.capturedAtUtc : ""
    if (observed > latest) latest = observed
    const price = job.expectedPriceBaseUnits
    const token = job.network?.contracts?.paymentToken
    const delivered = job.outcome.deliveryReceived === true
    candidates.push({
      categoryKey: categoryFor(job),
      key: `erc8004-${job.identity.agentId}`,
      displayName: job.identity.name,
      category: categoryFor(job),
      operatorRelationship: "EXTERNAL_DISTINCT_OWNER",
      availability: "CALLABLE",
      priceBaseUnits: typeof price === "string" ? price : null,
      currency: typeof token === "string" ? token : null,
      quoteExpiresAtUnix: null,
      completedJobs: delivered ? 1 : 0,
      refundedJobs: delivered ? 0 : 1,
      evidenceClass: "testnet_observation",
    })
  }
  return { candidates, latestObservationUtc: latest }
}

export function buildSnapshot(
  external: ReadonlyArray<Candidate & { categoryKey: string }>,
  latestObservationUtc: string,
  nowUnix: number = Math.floor(Date.parse(latestObservationUtc) / 1000),
): ComparisonSnapshot {
  const keys = [...new Set([...KNOT_CANDIDATES, ...external].map((entry) => entry.categoryKey))].sort()
  return {
    observationsThroughUtc: latestObservationUtc,
    categories: keys.map((key) => {
      const candidates = [...KNOT_CANDIDATES, ...external]
        .filter((entry) => entry.categoryKey === key)
        .map(({ categoryKey: _ignored, ...candidate }) => candidate)
      return {
        key,
        label: CATEGORY_LABELS[key] ?? key,
        candidates,
        comparison: compareCandidates(candidates, key, nowUnix),
      }
    }),
  }
}

async function main(): Promise<void> {
  const { candidates, latestObservationUtc } = await readExternalCandidates()
  const snapshot = buildSnapshot(candidates, latestObservationUtc)
  await writeFile(TARGET, `${JSON.stringify(snapshot, null, 2)}\n`)
  for (const category of snapshot.categories) {
    process.stderr.write(`[comparison] ${category.key}: ${category.candidates.length} candidate(s)\n`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
