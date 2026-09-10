import assert from "node:assert/strict"
import { mkdtemp, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { beginSessionJournal, readSessionJournal, saveSessionJournal, withSessionJournalLock } from "../../packages/authority/src/session-journal.ts"
import { smallestSpendWindowContaining, startOfSpendPeriod } from "../../packages/authority/src/spend-period.ts"

const state = () => ({ keyHash: `0x${"1".repeat(64)}`, phase: "prepared" as const, sessionPrivateKey: "synthetic-test-key" })
async function fixture() { return join(await mkdtemp(join(tmpdir(), "knot-session-test-")), "session.json") }

test("SESSION-RECOVERY-01 initial intent is private and cannot be replaced while uncertain", async () => {
  const path = await fixture()
  await withSessionJournalLock(path, async () => {
    await beginSessionJournal(path, state())
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700)
    await assert.rejects(beginSessionJournal(path, { ...state(), keyHash: `0x${"2".repeat(64)}` }), /uncertain session/)
    assert.deepEqual(await readSessionJournal(path), state())
  })
})
test("SESSION-RECOVERY-02 submitted hash survives a receipt timeout and lock is released", async () => {
  const path = await fixture()
  const pending = { ...state(), phase: "grant-submitted" as const, grantTransactionHash: `0x${"3".repeat(64)}` }
  await assert.rejects(withSessionJournalLock(path, async () => {
    await beginSessionJournal(path, state())
    await saveSessionJournal(path, pending)
    throw new Error("receipt timeout")
  }), /receipt timeout/)
  assert.deepEqual(await readSessionJournal(path), pending)
  await withSessionJournalLock(path, async () => { await assert.rejects(beginSessionJournal(path, state()), /uncertain session/) })
})
test("SESSION-RECOVERY-03 concurrent grants are refused and revoked records are archived", async () => {
  const path = await fixture()
  await withSessionJournalLock(path, async () => {
    await assert.rejects(withSessionJournalLock(path, async () => {}), /EEXIST/)
    await beginSessionJournal(path, state())
    await saveSessionJournal(path, { ...state(), phase: "revoked" })
    await beginSessionJournal(path, { ...state(), keyHash: `0x${"4".repeat(64)}` })
    assert.equal((await readdir(join(path, ".."))).filter(name => name.endsWith(".archive")).length, 1)
  })
})
test("SESSION-SPEND-01 a midnight-crossing session cannot receive a resetting daily cap", () => {
  for (const iso of ["2026-09-10T23:30:00Z", "2026-09-30T23:30:00Z", "2026-12-31T23:30:00Z"]) {
    const start = Date.parse(iso) / 1000
    const end = start + 3600
    const window = smallestSpendWindowContaining(start, end)
    if (window) {
      assert.notEqual(window.period, "day")
      assert.equal(startOfSpendPeriod(start, window.period), startOfSpendPeriod(end, window.period))
      assert.ok(window.periodEndUnix > end)
    } else assert.equal(iso, "2026-12-31T23:30:00Z")
  }
})
