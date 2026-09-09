import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { ClaimLedgerValidationError, verifyClaimLedger } from "../../packages/evidence/src/index.ts"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const ledgerPath = resolve(repositoryRoot, "evidence/claims.json")

test("the public claim ledger has closed records and valid local evidence bindings", () => {
  const ledger = verifyClaimLedger(readLedger(), repositoryRoot)
  assert.equal(ledger.schemaVersion, "knot.claims/1")
  assert.equal(ledger.claims.length, 19)
})

test("claim schema rejects unknown fields, statuses, evidence classes, and duplicate IDs", () => {
  const unknown = readLedger()
  unknown.unreviewed = true
  rejects(unknown, "SCHEMA_INVALID")

  const status = readLedger()
  claim(status, 0).status = "VERIFIED"
  rejects(status, "SCHEMA_INVALID")

  const evidenceClass = readLedger()
  claim(evidenceClass, 0).evidenceClasses = ["live_forever"]
  rejects(evidenceClass, "SCHEMA_INVALID")

  const duplicate = readLedger()
  claim(duplicate, 1).id = claim(duplicate, 0).id
  rejects(duplicate, "SCHEMA_INVALID")
})

test("claims require nonempty evidence classes, scope, sources, and limitations", () => {
  for (const [field, value] of [["evidenceClasses", []], ["scope", {}], ["sources", []], ["limitations", []]] as const) {
    const ledger = readLedger()
    claim(ledger, 0)[field] = value
    rejects(ledger, "SCHEMA_INVALID")
  }
})

test("repository evidence paths cannot escape, disappear, or resolve to a directory", () => {
  const traversal = readLedger()
  pathSource(traversal).path = "../package.json"
  rejects(traversal, "PATH_INVALID")

  const missing = readLedger()
  pathSource(missing).path = "evidence/does-not-exist.json"
  rejects(missing, "PATH_MISSING")

  const directory = readLedger()
  pathSource(directory).path = "evidence"
  rejects(directory, "PATH_INVALID")
})

test("repository evidence symlinks cannot resolve outside the repository", () => {
  const temporary = mkdtempSync(join(tmpdir(), "knot-claim-ledger-"))
  const root = join(temporary, "repository")
  const outside = join(temporary, "outside.json")
  try {
    mkdirSync(root)
    writeFileSync(outside, "{}")
    symlinkSync(outside, join(root, "evidence.json"))
    const ledger = readLedger()
    const first = claim(ledger, 0)
    first.sources = [{ type: "repository_file", path: "evidence.json" }]
    ledger.claims = [first]
    assert.throws(
      () => verifyClaimLedger(ledger, root),
      (error) => error instanceof ClaimLedgerValidationError && error.code === "PATH_INVALID",
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("declared repository content hashes are recomputed from file bytes", () => {
  const ledger = readLedger()
  const source = sources(ledger).find((item) => item.type === "frozen_rules")
  assert.ok(source)
  source.contentHash = `0x${"0".repeat(64)}`
  rejects(ledger, "HASH_MISMATCH")
})

test("commands are allowlisted documentary strings and are never interpreted", () => {
  const injected = readLedger()
  commandSource(injected).command = "npm run test:root && touch evidence/command-ran"
  rejects(injected, "COMMAND_NOT_ALLOWED")

  const mismatched = readLedger()
  const dataset = sources(mismatched).find((item) => item.type === "paired_experiment_dataset")
  assert.ok(dataset)
  dataset.command = "npm run advantage:verify -- evidence/claims.json"
  rejects(mismatched, "COMMAND_NOT_ALLOWED")
})

test("timestamps, observation windows, and remote URLs are structurally constrained", () => {
  const timestamp = readLedger()
  timestamp.updatedAtUtc = "tomorrow"
  rejects(timestamp, "SCHEMA_INVALID")

  const window = readLedger()
  const observed = claim(window, 12)
  observed.observationWindow = { fromUtc: "2026-09-09T10:00:00.000Z", toUtc: "2026-09-09T09:00:00.000Z" }
  rejects(window, "SCHEMA_INVALID")

  const url = readLedger()
  const remote = sources(url).find((item) => item.type === "https_probe")
  assert.ok(remote)
  remote.url = "http://user:password@example.com/status"
  rejects(url, "SCHEMA_INVALID")
})

test("a remote deliverable hash is format-checked but not presented as fetched or verified", () => {
  const ledger = readLedger()
  const deliverable = sources(ledger).find((item) => item.type === "deliverable")
  assert.ok(deliverable)
  deliverable.sha256 = "not-a-digest"
  rejects(ledger, "SCHEMA_INVALID")
})

function readLedger(): Record<string, unknown> {
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>
}

function claims(ledger: Record<string, unknown>): Array<Record<string, unknown>> {
  return ledger.claims as Array<Record<string, unknown>>
}

function claim(ledger: Record<string, unknown>, index: number): Record<string, unknown> {
  const value = claims(ledger)[index]
  assert.ok(value)
  return value
}

function sources(ledger: Record<string, unknown>): Array<Record<string, unknown>> {
  return claims(ledger).flatMap((item) => item.sources as Array<Record<string, unknown>>)
}

function pathSource(ledger: Record<string, unknown>): Record<string, unknown> {
  const source = sources(ledger).find((item) => typeof item.path === "string")
  assert.ok(source)
  return source
}

function commandSource(ledger: Record<string, unknown>): Record<string, unknown> {
  const source = sources(ledger).find((item) => typeof item.command === "string")
  assert.ok(source)
  return source
}

function rejects(candidate: unknown, code: ClaimLedgerValidationError["code"]): void {
  assert.throws(
    () => verifyClaimLedger(candidate, repositoryRoot),
    (error) => error instanceof ClaimLedgerValidationError && error.code === code,
  )
}
