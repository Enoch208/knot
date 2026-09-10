import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { collectCoverage } from "../../scripts/build-discovery-coverage.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SNAPSHOT = join(ROOT, "apps", "web", "src", "discovery-coverage.snapshot.json")

interface Snapshot {
  registries: { chainId: number; registeredTotal: number; observedAtUtc: string }[]
  callableThroughKnot: number
  externallyOperatedHiresAttempted: number
  externallyOperatedHiresDelivered: number
  limitation: string
}

const readSnapshot = async (): Promise<Snapshot> =>
  JSON.parse(await readFile(SNAPSHOT, "utf8")) as Snapshot

test("the published external-hire record matches the evidence directory exactly", async () => {
  const snapshot = await readSnapshot()
  const directory = join(ROOT, "evidence", "testnet")
  const names = (await readdir(directory)).filter((name) => name.startsWith("external-paid-job-"))

  let delivered = 0
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as {
      outcome?: { deliveryReceived?: unknown }
    }
    if (parsed.outcome?.deliveryReceived === true) delivered += 1
  }

  assert.equal(
    snapshot.externallyOperatedHiresAttempted,
    names.length,
    "run `npm run discovery:coverage` — the published attempt count has drifted from evidence/testnet",
  )
  assert.equal(
    snapshot.externallyOperatedHiresDelivered,
    delivered,
    "run `npm run discovery:coverage` — the published delivery count has drifted from evidence/testnet",
  )
})

test("delivered never exceeds attempted", async () => {
  const snapshot = await readSnapshot()
  assert.ok(
    snapshot.externallyOperatedHiresDelivered <= snapshot.externallyOperatedHiresAttempted,
    "a delivery count above the attempt count would be fabricated",
  )
})

test("the callable count never exceeds the smaller registry total", async () => {
  const snapshot = await readSnapshot()
  const smallest = Math.min(...snapshot.registries.map((registry) => registry.registeredTotal))
  assert.ok(snapshot.callableThroughKnot <= smallest)
  assert.ok(snapshot.callableThroughKnot > 0)
})

test("every registry total carries an observation timestamp and a positive count", async () => {
  const snapshot = await readSnapshot()
  assert.equal(snapshot.registries.length, 2)
  for (const registry of snapshot.registries) {
    assert.ok(Number.isInteger(registry.registeredTotal) && registry.registeredTotal > 0)
    assert.ok(!Number.isNaN(Date.parse(registry.observedAtUtc)))
  }
})

test("the snapshot states that registration is not capability", async () => {
  const snapshot = await readSnapshot()
  assert.match(snapshot.limitation, /does not establish/)
  assert.match(snapshot.limitation, /has not enumerated/)
})

test("collectCoverage reports whatever the index returns without inflating it", async () => {
  const observed: number[] = []
  const registries = await collectCoverage({
    async listAgents({ chainId }: { chainId: number }) {
      observed.push(chainId)
      return {
        coverage: {
          matchingTotal: chainId === 56 ? 311_437 : 2_388,
          returnedCount: 1,
          observedAtUtc: "2026-09-10T12:00:00.000Z",
          requestUri: `https://8004scan.io/api/v1/agents?limit=1&chain_id=${chainId}`,
        },
        page: { items: [] },
      }
    },
  } as unknown as Parameters<typeof collectCoverage>[0])

  assert.deepEqual(observed, [56, 97])
  assert.equal(registries[0]?.registeredTotal, 311_437)
  assert.equal(registries[1]?.registeredTotal, 2_388)
})
