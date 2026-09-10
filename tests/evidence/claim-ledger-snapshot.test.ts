import { deepStrictEqual, ok } from "node:assert/strict"
import { test } from "node:test"
import {
  projectLedger,
  readSnapshot,
  readSourceLedger,
} from "../../scripts/build-claim-ledger-snapshot.ts"

test("the published claim snapshot matches evidence/claims.json exactly", async () => {
  const snapshot = await readSnapshot()
  const projected = projectLedger(await readSourceLedger(), snapshot.updatedAtUtc)
  deepStrictEqual(
    snapshot.claims,
    projected.claims,
    "run `npm run ledger:snapshot` — the web claim ledger has drifted from the evidence ledger",
  )
})

test("the snapshot never invents a claim the evidence ledger does not carry", async () => {
  const snapshot = await readSnapshot()
  const source = await readSourceLedger()
  const sourceIds = new Set(projectLedger(source, "").claims.map((claim) => claim.id))
  for (const claim of snapshot.claims) {
    ok(sourceIds.has(claim.id), `snapshot claim ${claim.id} is absent from evidence/claims.json`)
  }
})

test("every projected claim carries a recognised status", async () => {
  const projected = projectLedger(await readSourceLedger(), "")
  const allowed = new Set(["SUPPORTED", "PARTIAL", "UNMEASURED", "NOT_CLAIMED"])
  for (const claim of projected.claims) {
    ok(allowed.has(claim.status), `claim ${claim.id} carries unknown status ${claim.status}`)
  }
  ok(projected.claims.length > 0, "the evidence ledger projected zero claims")
})
