import assert from "node:assert/strict"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"
import {
  acknowledgeProgram,
  backupProgram,
  command,
  completeSnapshot,
  manifestProgram,
  migratedTableNames,
  repository,
  restoreProgram,
  testEnvironment,
} from "./backend-snapshot-fixture.ts"

test("snapshot inventory matches the clean migration table set", async () => {
  assert.ok(migratedTableNames.includes("service_requests"))
  assert.ok(migratedTableNames.includes("verified_quotes"))
  assert.ok(migratedTableNames.includes("erc8004_identity_observations"))
  assert.equal(migratedTableNames.includes("seller_requests"), false)
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "schema-inventory")
  await completeSnapshot(snapshot)
  const counts = (await readFile(resolve(snapshot, "database-counts.tsv"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[0])
  assert.deepEqual(counts, migratedTableNames)
})

async function failureRecord(lock: string) {
  return {
    id: (await readFile(resolve(lock, "FAILED/id"), "utf8")).trim(),
    phase: (await readFile(resolve(lock, "FAILED/phase"), "utf8")).trim(),
    target: (await readFile(resolve(lock, "FAILED/target"), "utf8")).trim(),
  }
}

test("manifest validation binds release, inactive database, both bucket inventories, and completion", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "snapshot")
  await completeSnapshot(snapshot)
  await command(process.execPath, [manifestProgram, "validate", snapshot])
  await command(process.execPath, [manifestProgram, "compatible", snapshot, repository, resolve(snapshot, "deployed-images.tsv")])
  const incompleteImages = resolve(fixture.root, "incomplete-images.tsv")
  const imageLines = (await readFile(resolve(snapshot, "deployed-images.tsv"), "utf8")).trim().split("\n")
  await writeFile(incompleteImages, `${imageLines.slice(0, 4).join("\n")}\n`)
  await assert.rejects(command(process.execPath, [manifestProgram, "compatible", snapshot, repository, incompleteImages]), /deployed image set is incomplete/)
  await writeFile(resolve(snapshot, "buckets/knot-deliverables/purchased.json"), "changed")
  await assert.rejects(command(process.execPath, [manifestProgram, "validate", snapshot]), /knot-deliverables inventory differs/)
})

test("restore rejects one seller image reference and id drift before shadow creation", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], {
    ...fixture.env,
    KNOT_TEST_SELLER_IMAGE_DRIFT: "gridquant-container",
  }), /snapshot release is incompatible/)
  const log = await readFile(fixture.log, "utf8")
  assert.doesNotMatch(log, /dropdb/)
  await assert.rejects(stat(fixture.lock))
})

test("backup quiesces every writer, inventories both buckets, and health-checks every restart", async () => {
  const fixture = await testEnvironment()
  const destination = resolve(fixture.root, "backups")
  const result = await command(backupProgram, [destination], fixture.env)
  const snapshot = result.stdout.trim()
  await command(process.execPath, [manifestProgram, "validate", snapshot])
  assert.equal((await stat(snapshot)).mode & 0o077, 0)
  assert.equal((await stat(resolve(snapshot, "manifest.json"))).mode & 0o077, 0)
  assert.equal(await readFile(resolve(snapshot, "buckets/knot-artifacts/result.json"), "utf8"), "original-artifact")
  assert.equal(await readFile(resolve(snapshot, "buckets/knot-deliverables/purchased.json"), "utf8"), "original-deliverable")
  const log = await readFile(fixture.log, "utf8")
  assert.equal(log.match(/stop agent/g)?.length, 4)
  assert.equal(log.match(/start agent/g)?.length, 4)
  assert.ok(log.lastIndexOf("stop agent") < log.indexOf("pg_dump"))
  assert.ok(log.indexOf("pg_dump") < log.indexOf("start api worker"))
  assert.match(log, /exec -T api node -e/)
  await assert.rejects(stat(fixture.lock))
  assert.equal((await readdir(destination)).some((name) => name.includes("incomplete")), false)
  await assert.rejects(command(backupProgram, [destination], fixture.env), /snapshot destination already exists/)
})

test("deployment-wide lock rejects overlapping maintenance before container access", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  await mkdir(fixture.lock)
  await writeFile(resolve(fixture.lock, "owner"), "another-operation\n")
  await assert.rejects(command(backupProgram, [resolve(fixture.root, "backups")], fixture.env), /holds the maintenance lock/)
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], fixture.env), /holds the maintenance lock/)
  await assert.rejects(stat(fixture.log))
})

test("backup refuses active work and restarts every writer", async () => {
  const fixture = await testEnvironment()
  const destination = resolve(fixture.root, "backups")
  await assert.rejects(command(backupProgram, [destination], { ...fixture.env, KNOT_TEST_ACTIVE_COUNT: "2" }), /active jobs or chain actions/)
  const log = await readFile(fixture.log, "utf8")
  assert.match(log, /start api worker/)
  assert.equal(log.match(/start agent/g)?.length, 4)
  assert.equal((await readdir(destination)).length, 0)
  await assert.rejects(stat(fixture.lock))
})

test("restore rejects an active source database after shadow restore and before quiescing production", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "active-target")
  await completeSnapshot(snapshot, "ACTIVE-target-database")
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], fixture.env), /active jobs or chain actions/)
  assert.equal(await readFile(resolve(fixture.state, "db-primary.dump"), "utf8"), "original-database")
  const log = await readFile(fixture.log, "utf8")
  assert.doesNotMatch(log, /stop api worker/)
  assert.equal((await readdir(resolve(fixture.state, "buckets"))).some((name) => name.startsWith("knot-restore-")), false)
  await assert.rejects(stat(fixture.lock))
})

test("restore cleans a shadow bucket that fails after creation", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], {
    ...fixture.env,
    KNOT_TEST_FAIL_SHADOW_BUCKET: "knot-restore-deliverables-",
  }))
  assert.equal((await readdir(resolve(fixture.state, "buckets"))).some((name) => name.startsWith("knot-restore-")), false)
  assert.equal(await readFile(resolve(fixture.state, "db-primary.dump"), "utf8"), "original-database")
  await assert.rejects(stat(fixture.lock))
})

test("restore rolls back the database and both buckets after a cutover failure", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  const rollback = resolve(fixture.root, "private-rollback")
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], {
    ...fixture.env,
    KNOT_ROLLBACK_DIRECTORY: rollback,
    KNOT_TEST_TARGET_SNAPSHOT: snapshot,
  }), /applying private rollback snapshot/)
  assert.equal(await readFile(resolve(fixture.state, "db-primary.dump"), "utf8"), "original-database")
  assert.equal(await readFile(resolve(fixture.state, "buckets/knot-artifacts/result.json"), "utf8"), "original-artifact")
  assert.equal(await readFile(resolve(fixture.state, "buckets/knot-deliverables/purchased.json"), "utf8"), "original-deliverable")
  assert.equal((await readdir(rollback)).length, 1)
  await assert.rejects(stat(fixture.lock))
})

test("restore succeeds only after two-bucket readback and every writer health check", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  const rollback = resolve(fixture.root, "private-rollback")
  const result = await command(restoreProgram, [snapshot, "--confirm-replace"], { ...fixture.env, KNOT_ROLLBACK_DIRECTORY: rollback })
  assert.match(result.stdout, /restore complete; rollback snapshot retained/)
  assert.equal(await readFile(resolve(fixture.state, "db-primary.dump"), "utf8"), "target-database")
  assert.equal(await readFile(resolve(fixture.state, "buckets/knot-artifacts/result.json"), "utf8"), "target-artifact")
  assert.equal(await readFile(resolve(fixture.state, "buckets/knot-deliverables/purchased.json"), "utf8"), "target-deliverable")
  const log = await readFile(fixture.log, "utf8")
  assert.ok(log.lastIndexOf("start agent") < log.lastIndexOf("exec -T api node -e"))
  assert.equal((await readdir(rollback)).length, 1)
  await assert.rejects(stat(fixture.lock))
})

test("uncertain writer health persists an exact target-bound interlock until acknowledgement", async () => {
  const fixture = await testEnvironment()
  const destination = resolve(fixture.root, "backups")
  const target = resolve(destination, "20260909T160000Z")
  await assert.rejects(command(backupProgram, [destination], { ...fixture.env, KNOT_TEST_HEALTH_FAILURE: "1" }), /writer health check failed/)
  const failure = await failureRecord(fixture.lock)
  assert.equal(failure.phase, "writer-health")
  assert.equal(failure.target, target)
  await assert.rejects(command(backupProgram, [resolve(fixture.root, "another-backups")], fixture.env), /requires explicit acknowledgement/)
  await assert.rejects(command(restoreProgram, [target, "--confirm-replace"], fixture.env), /requires explicit acknowledgement/)
  await assert.rejects(command(acknowledgeProgram, [fixture.lock, `${failure.id}9`, target, "--confirm-clear"]), /failure identifier does not match/)
  await assert.rejects(command(acknowledgeProgram, [fixture.lock, failure.id, resolve(fixture.root, "wrong-target"), "--confirm-clear"]), /operation target does not match/)
  await command(acknowledgeProgram, [fixture.lock, failure.id, target, "--confirm-clear"])
  await assert.rejects(stat(fixture.lock))
})

test("uncertain writer restart persists a failed interlock", async () => {
  const fixture = await testEnvironment()
  await assert.rejects(command(backupProgram, [resolve(fixture.root, "backups")], { ...fixture.env, KNOT_TEST_START_FAILURE: "1" }), /writer restart failed/)
  const failure = await failureRecord(fixture.lock)
  assert.equal(failure.phase, "writer-restart")
})

test("uncertain automatic rollback persists a failed interlock", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], {
    ...fixture.env,
    KNOT_ROLLBACK_DIRECTORY: resolve(fixture.root, "private-rollback"),
    KNOT_TEST_TARGET_SNAPSHOT: snapshot,
    KNOT_TEST_FAIL_ROLLBACK: "1",
  }), /automatic rollback failed/)
  const failure = await failureRecord(fixture.lock)
  assert.equal(failure.phase, "automatic-rollback")
  assert.equal(failure.target, snapshot)
})

test("uncertain rollback readback persists a failed interlock", async () => {
  const fixture = await testEnvironment()
  const snapshot = resolve(fixture.root, "target")
  await completeSnapshot(snapshot)
  await assert.rejects(command(restoreProgram, [snapshot, "--confirm-replace"], {
    ...fixture.env,
    KNOT_ROLLBACK_DIRECTORY: resolve(fixture.root, "private-rollback"),
    KNOT_TEST_TARGET_SNAPSHOT: snapshot,
    KNOT_TEST_FAIL_ROLLBACK_READBACK: "1",
  }), /automatic rollback readback failed/)
  const failure = await failureRecord(fixture.lock)
  assert.equal(failure.phase, "rollback-readback")
  assert.equal(failure.target, snapshot)
})
