#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ScanClient } from "../packages/discovery/src/index.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TARGET = join(ROOT, "apps", "web", "src", "discovery-coverage.snapshot.json")

export interface RegistryCoverage {
  chainId: 56 | 97
  label: string
  registeredTotal: number
  observedAtUtc: string
  requestUri: string
}

export interface DiscoveryCoverage {
  updatedAtUtc: string
  registries: RegistryCoverage[]
  callableThroughKnot: number
  externallyOperatedHiresAttempted: number
  externallyOperatedHiresDelivered: number
  limitation: string
}

const LIMITATION =
  "Registered totals are reported by the 8004scan index at the observed time. Registration records an identity; it does not establish that an agent is reachable, that it supports a given task, or that it will deliver. KNOT has not enumerated or validated every registered agent."

export async function collectCoverage(
  client: Pick<ScanClient, "listAgents">,
): Promise<RegistryCoverage[]> {
  const registries: RegistryCoverage[] = []
  for (const chainId of [56, 97] as const) {
    const result = await client.listAgents({ chainId, limit: 1 })
    registries.push({
      chainId,
      label: chainId === 56 ? "BSC mainnet" : "BSC testnet",
      registeredTotal: result.coverage.matchingTotal,
      observedAtUtc: result.coverage.observedAtUtc,
      requestUri: result.coverage.requestUri,
    })
  }
  return registries
}

async function countExternalHires(): Promise<{ attempted: number; delivered: number }> {
  const directory = join(ROOT, "evidence", "testnet")
  const { readdir } = await import("node:fs/promises")
  const names = (await readdir(directory)).filter((name) => name.startsWith("external-paid-job-"))
  let delivered = 0
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as {
      outcome?: { deliveryReceived?: unknown }
    }
    if (parsed.outcome?.deliveryReceived === true) delivered += 1
  }
  return { attempted: names.length, delivered }
}

async function main(): Promise<void> {
  const apiKey = process.env.KNOT_SCAN_API_KEY
  const client = new ScanClient(apiKey === undefined ? {} : { apiKey })
  const registries = await collectCoverage(client)
  const external = await countExternalHires()

  const snapshot: DiscoveryCoverage = {
    updatedAtUtc: new Date().toISOString(),
    registries,
    callableThroughKnot: 4,
    externallyOperatedHiresAttempted: external.attempted,
    externallyOperatedHiresDelivered: external.delivered,
    limitation: LIMITATION,
  }

  await writeFile(TARGET, `${JSON.stringify(snapshot, null, 2)}\n`)
  for (const registry of registries) {
    process.stderr.write(
      `[discovery] ${registry.label} (${registry.chainId}): ${registry.registeredTotal} registered at ${registry.observedAtUtc}\n`,
    )
  }
  process.stderr.write(
    `[discovery] externally operated hires attempted ${external.attempted}, delivered ${external.delivered}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
