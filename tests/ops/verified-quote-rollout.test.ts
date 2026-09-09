import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const evidence = JSON.parse(
  readFileSync("evidence/operations/verified-quote-rollout-20260909.json", "utf8"),
) as Record<string, unknown>

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

test("verified quote rollout evidence stays within its deployed non-funding boundary", () => {
  assert.equal(evidence.schemaVersion, "knot.verified-quote-rollout/1")
  const release = evidence.release as Record<string, unknown>
  assert.equal(release.releaseTag, "ce9bc1f260f1")
  assert.equal(
    release.immutableImageId,
    "sha256:8e8f568e07bc3564fd2583ce473809c8b4cd56500f0fcbd1f18df880e5ec59d7",
  )
  const database = evidence.database as Record<string, unknown>
  assert.equal(database.migrationCount, 10)
  assert.equal(database.serviceRequestRowCount, 0)
  assert.equal(database.verifiedQuoteRowCount, 0)
  assert.equal(database.activeJobCount, 0)
  assert.equal(database.activeChainActionCount, 0)
  assert.equal(database.unpublishedOutboxCount, 0)
  const migrations = database.newMigrations as Array<Record<string, unknown>>
  assert.deepEqual(
    migrations.map((entry) => [entry.name, entry.sha256]),
    [
      ["0009_service_request_transport.sql", sha256("packages/db/migrations/0009_service_request_transport.sql")],
      ["0010_verified_quotes.sql", sha256("packages/db/migrations/0010_verified_quotes.sql")],
    ],
  )
  const publicChecks = evidence.publicChecks as Array<Record<string, unknown>>
  assert.equal(publicChecks.length, 5)
  assert.ok(publicChecks.every((entry) => entry.httpStatus === 200))
  const recovery = evidence.recovery as Record<string, unknown>
  assert.equal(recovery.preMigrationDumpMode, "0600")
  assert.equal(recovery.shadowRestoreVerified, true)
  assert.equal(recovery.guardedRollbackObserved, true)
  const boundary = evidence.boundary as Record<string, unknown>
  assert.deepEqual(boundary, {
    authenticatedServiceRequestCreated: false,
    authenticatedSellerNegotiationPerformed: false,
    verifiedQuotePersistedLive: false,
    verifiedQuoteApiRoutePresent: false,
    jobCreated: false,
    fundingPermitted: false,
    walletAccessed: false,
    chainRpcUsed: false,
    chainWritePerformed: false,
    mainnetWritePerformed: false,
    frontendChanged: false,
  })
})
