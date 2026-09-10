import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const evidence = JSON.parse(
  readFileSync("evidence/operations/verified-quote-live-20260910.json", "utf8"),
) as Record<string, unknown>

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

test("live verified quote evidence binds the deployed quote-only boundary", () => {
  assert.equal(evidence.schemaVersion, "knot.verified-quote-live/1")

  const release = evidence.release as Record<string, unknown>
  assert.deepEqual(release, {
    gitCommit: "80e3b45487d4042b9da4fa5e0b1fd22add79e784",
    releaseTag: "80e3b45",
    imageReference:
      "knot/backend@sha256:482666c2740a6c14f1490c40ec14c0dc32a2fb6c782fdbd8c6e3cf0da190ae87",
    immutableImageId:
      "sha256:482666c2740a6c14f1490c40ec14c0dc32a2fb6c782fdbd8c6e3cf0da190ae87",
    previousReleaseTag: "67668b1",
  })

  const database = evidence.database as Record<string, unknown>
  assert.equal(database.migrationCount, 12)
  assert.deepEqual(database.newMigrations, [
    {
      name: "0011_erc8004_identity_observations.sql",
      sha256: sha256("packages/db/migrations/0011_erc8004_identity_observations.sql"),
    },
    {
      name: "0012_verified_quote_identity_observation.sql",
      sha256: sha256("packages/db/migrations/0012_verified_quote_identity_observation.sql"),
    },
  ])
  assert.deepEqual(
    {
      taskRowCount: database.taskRowCount,
      serviceRequestRowCount: database.serviceRequestRowCount,
      verifiedQuoteRowCount: database.verifiedQuoteRowCount,
      identityObservationRowCount: database.identityObservationRowCount,
      endpointObservationRowCount: database.endpointObservationRowCount,
      jobRowCount: database.jobRowCount,
      outboxRowCount: database.outboxRowCount,
      chainActionRowCount: database.chainActionRowCount,
    },
    {
      taskRowCount: 3,
      serviceRequestRowCount: 3,
      verifiedQuoteRowCount: 1,
      identityObservationRowCount: 1,
      endpointObservationRowCount: 1,
      jobRowCount: 0,
      outboxRowCount: 0,
      chainActionRowCount: 0,
    },
  )

  const demo = evidence.demo as Record<string, unknown>
  assert.deepEqual(
    {
      mode: demo.mode,
      stage: demo.stage,
      taskCreateHttpStatus: demo.taskCreateHttpStatus,
      serviceRequestCreateHttpStatus: demo.serviceRequestCreateHttpStatus,
      quoteCreateHttpStatus: demo.quoteCreateHttpStatus,
      idempotentRetryHttpStatus: demo.idempotentRetryHttpStatus,
      idempotentRetryPreservedNegotiationHash: demo.idempotentRetryPreservedNegotiationHash,
      fundingPermitted: demo.fundingPermitted,
    },
    {
      mode: "QUOTE_ONLY",
      stage: "VERIFIED_PRE_FUNDING",
      taskCreateHttpStatus: 201,
      serviceRequestCreateHttpStatus: 201,
      quoteCreateHttpStatus: 201,
      idempotentRetryHttpStatus: 200,
      idempotentRetryPreservedNegotiationHash: true,
      fundingPermitted: false,
    },
  )

  const identity = evidence.identityObservation as Record<string, unknown>
  assert.deepEqual(
    {
      chainId: identity.chainId,
      agentId: identity.agentId,
      providerCount: identity.providerCount,
      status: identity.status,
    },
    { chainId: 97, agentId: "2297", providerCount: 2, status: "CONFIRMED" },
  )

  const publicChecks = evidence.publicChecks as Array<Record<string, unknown>>
  assert.equal(publicChecks.length, 6)
  assert.ok(publicChecks.every((entry) => entry.httpStatus === 200))

  const unauthenticated = evidence.unauthenticatedRequestCheck as Record<string, unknown>
  assert.deepEqual(unauthenticated, {
    method: "POST",
    path: "/api/tasks/nonexistent/service-requests",
    httpStatus: 401,
    code: "AUTHORITY_MISMATCH",
    serviceRequestRowCountBefore: 3,
    serviceRequestRowCountAfter: 3,
  })

  const incident = evidence.incident as Record<string, unknown>
  assert.equal(incident.initialQuoteAttempts, 2)
  assert.equal(incident.initialHttpStatus, 503)
  assert.equal(incident.partialQuoteRowsCreated, 0)
  assert.equal(incident.partialJobsCreated, 0)
  assert.equal(incident.partialOutboxRowsCreated, 0)
  assert.equal(incident.partialChainActionsCreated, 0)
  assert.equal(incident.fixCommit, release.gitCommit)

  const boundary = evidence.boundary as Record<string, unknown>
  assert.deepEqual(boundary, {
    authenticatedServiceRequestCreated: true,
    authenticatedSellerNegotiationPerformed: true,
    verifiedQuotePersistedLive: true,
    identityReadRpcUsed: true,
    jobCreated: false,
    fundingPermitted: false,
    walletAccessed: false,
    chainWritePerformed: false,
    mainnetWritePerformed: false,
    retainedMainnetSnapshotReadOnly: true,
    frontendChanged: false,
  })
})
