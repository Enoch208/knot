import assert from "node:assert/strict"
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { backupProgram, command, completeSnapshot, manifestProgram, repository, testEnvironment } from "./backend-snapshot-fixture.ts"

test("BACKUP-ARCHIVE-01 captures and validates a release archive without git metadata", async () => {
  const fixture = await testEnvironment()
  const release = resolve(fixture.root, "release")
  for (const relative of ["packages/db/migrations", "package-lock.json", "ops/backend/compose.yaml", "ops/manifests/network-56.json", "ops/manifests/network-97.json"]) {
    const destination = resolve(release, relative)
    await mkdir(dirname(destination), { recursive: true })
    await cp(resolve(repository, relative), destination, { recursive: true })
  }
  const commit = (await command("git", ["rev-parse", "HEAD"])).stdout.trim()
  await writeFile(resolve(release, ".release-commit"), `${commit}\n`)
  const snapshot = resolve(fixture.root, "snapshot")
  await completeSnapshot(snapshot, "database", release)
  await command(process.execPath, [manifestProgram, "validate", snapshot])
  assert.equal(JSON.parse(await readFile(resolve(snapshot, "manifest.json"), "utf8")).release.gitCommit, commit)
  await writeFile(resolve(release, ".release-commit"), "not a commit")
  await assert.rejects(completeSnapshot(resolve(fixture.root, "invalid"), "database", release), /marker is invalid/)
})
test("BACKUP-ARCHIVE-02 rejects missing provenance and symlinked commit markers", async () => {
  const fixture = await testEnvironment()
  const module = resolve(repository, "ops/backend/release-identity.mjs")
  const inspect = (path: string) => command(process.execPath, ["--input-type=module", "-e", `import {readReleaseCommit} from ${JSON.stringify(module)}; await readReleaseCommit(${JSON.stringify(path)});`])
  const release = resolve(fixture.root, "release")
  await mkdir(release)
  await assert.rejects(inspect(release), /valid .release-commit/)
  await writeFile(resolve(fixture.root, "marker"), "a".repeat(40))
  await symlink(resolve(fixture.root, "marker"), resolve(release, ".release-commit"))
  await assert.rejects(inspect(release), /regular file/)
})
test("BACKUP-IMAGE-01 records a verified immutable digest for tag-started containers", async () => {
  const fixture = await testEnvironment()
  const result = await command(backupProgram, [resolve(fixture.root, "backup")], { ...fixture.env, KNOT_TEST_TAGGED_IMAGES: "1" })
  const manifest = JSON.parse(await readFile(resolve(result.stdout.trim(), "manifest.json"), "utf8"))
  assert.equal(manifest.release.deployedImages.length, 5)
  for (const image of manifest.release.deployedImages) assert.match(image.reference, /@sha256:/)
})
test("BACKUP-IMAGE-02 refuses a digest that resolves to a different image before quiescing", async () => {
  const fixture = await testEnvironment()
  await assert.rejects(command(backupProgram, [resolve(fixture.root, "backup")], {
    ...fixture.env, KNOT_TEST_TAGGED_IMAGES: "1", KNOT_TEST_RESOLVED_IMAGE_DRIFT: "1",
  }), /differs from running image/)
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /stop api|stop agent|pg_dump/)
})
