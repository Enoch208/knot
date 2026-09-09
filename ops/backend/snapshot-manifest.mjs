import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

const schemaVersion = "knot.backend.logical-snapshot/1"
const shaPattern = /^[0-9a-f]{64}$/
const imageIdPattern = /^sha256:[0-9a-f]{64}$/
const imageReferencePattern = /^[^\s]+@sha256:[0-9a-f]{64}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const expectedTables = [
  "agent_capabilities", "agents", "artifacts", "auditions", "benchmark_runs", "candidate_runs",
  "chain_action_recovery_attempts", "chain_actions", "claims", "endpoint_observations", "erc8004_identity_observations", "evaluations", "job_events", "jobs", "outbox",
  "quotes", "service_requests", "sessions", "snapshots", "tasks", "verified_quotes",
]
const bucketNames = ["knot-artifacts", "knot-deliverables"]
const imageNames = ["backend", "healthguard", "rangepilot", "gridquant", "yieldscout"]
const scopeIncludes = ["PostgreSQL logical rows and schema", "current knot-artifacts and knot-deliverables object bytes"]
const scopeExcludes = ["PostgreSQL physical files and WAL", "object versions and bucket metadata", "in-flight requests", "host configuration and secrets", "external chain state"]

function fail(message) {
  throw new Error(message)
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys are invalid`)
}

function validTimestamp(value) {
  return typeof value === "string" && timestampPattern.test(value) && Number.isFinite(Date.parse(value))
}

async function sha256(path) {
  const bytes = await readFile(path)
  return createHash("sha256").update(bytes).digest("hex")
}

async function fileRecord(root, path) {
  const details = await stat(path)
  return { path: relative(root, path).split(sep).join("/"), sha256: await sha256(path), byteLength: details.size }
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name)
    const details = await lstat(path)
    if (details.isSymbolicLink()) fail("snapshot artifacts cannot contain symbolic links")
    if (details.isDirectory()) files.push(...await walkFiles(root, path))
    else if (details.isFile()) files.push(await fileRecord(root, path))
    else fail("snapshot artifacts can contain regular files only")
  }
  return files
}

async function parseCounts(path) {
  const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  const counts = lines.map((line) => {
    const fields = line.split("\t")
    if (fields.length !== 2 || !/^[0-9]+$/.test(fields[1] ?? "")) fail("database counts are invalid")
    return { table: fields[0], rowCount: fields[1] }
  })
  if (JSON.stringify(counts.map((item) => item.table)) !== JSON.stringify(expectedTables)) fail("database count table set is incomplete")
  return counts
}

async function parseDeployedImages(path) {
  const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  const images = lines.map((line) => {
    const fields = line.split("\t")
    if (fields.length !== 3 || !imageReferencePattern.test(fields[1] ?? "") || !imageIdPattern.test(fields[2] ?? "")) fail("deployed image metadata is invalid")
    return { name: fields[0], reference: fields[1], imageId: fields[2] }
  })
  if (JSON.stringify(images.map((item) => item.name)) !== JSON.stringify(imageNames)) fail("deployed image set is incomplete")
  return images
}

async function releaseRecord(repository, deployedImagesPath) {
  const migrationsRoot = resolve(repository, "packages/db/migrations")
  const migrationNames = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql")).sort()
  if (migrationNames.length === 0) fail("no database migrations found")
  const migrations = []
  for (const name of migrationNames) migrations.push(await fileRecord(repository, resolve(migrationsRoot, name)))
  return {
    gitCommit: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    packageLock: await fileRecord(repository, resolve(repository, "package-lock.json")),
    migrations,
    compose: await fileRecord(repository, resolve(repository, "ops/backend/compose.yaml")),
    networkManifests: await Promise.all([56, 97].map((chainId) => fileRecord(repository, resolve(repository, `ops/manifests/network-${chainId}.json`)))),
    deployedImages: await parseDeployedImages(deployedImagesPath),
  }
}

async function capture(snapshot, repository, deployedImagesPath, capturedAtUtc) {
  if (!validTimestamp(capturedAtUtc)) fail("capture timestamp is invalid")
  const databaseDump = await fileRecord(snapshot, resolve(snapshot, "database.dump"))
  const countsPath = resolve(snapshot, "database-counts.tsv")
  const activeWorkCount = (await readFile(resolve(snapshot, "active-work-count.txt"), "utf8")).trim()
  if (activeWorkCount !== "0") fail("snapshot contains active jobs or chain actions")
  const buckets = []
  for (const name of bucketNames) {
    const objects = await walkFiles(resolve(snapshot, "buckets", name))
    buckets.push({ name, objectCount: objects.length, totalByteLength: objects.reduce((sum, item) => sum + item.byteLength, 0), objects })
  }
  const manifest = {
    schemaVersion,
    snapshotScope: {
      kind: "quiesced-logical-application-state",
      includes: scopeIncludes,
      excludes: scopeExcludes,
    },
    capturedAtUtc,
    release: await releaseRecord(repository, deployedImagesPath),
    database: { format: "postgres-custom", dump: databaseDump, countsSha256: await sha256(countsPath), activeWorkCount, tables: await parseCounts(countsPath) },
    artifacts: { buckets },
  }
  await writeFile(resolve(snapshot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
}

function validateFile(value, label) {
  exactKeys(value, ["path", "sha256", "byteLength"], label)
  if (typeof value.path !== "string" || value.path.startsWith("/") || value.path.includes("..")) fail(`${label} path is invalid`)
  if (!shaPattern.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) fail(`${label} metadata is invalid`)
}

async function readManifest(snapshot) {
  const manifest = JSON.parse(await readFile(resolve(snapshot, "manifest.json"), "utf8"))
  exactKeys(manifest, ["schemaVersion", "snapshotScope", "capturedAtUtc", "release", "database", "artifacts"], "manifest")
  if (manifest.schemaVersion !== schemaVersion || !validTimestamp(manifest.capturedAtUtc)) fail("manifest identity is invalid")
  exactKeys(manifest.snapshotScope, ["kind", "includes", "excludes"], "snapshot scope")
  if (manifest.snapshotScope.kind !== "quiesced-logical-application-state" || JSON.stringify(manifest.snapshotScope.includes) !== JSON.stringify(scopeIncludes) || JSON.stringify(manifest.snapshotScope.excludes) !== JSON.stringify(scopeExcludes)) fail("snapshot scope is invalid")
  exactKeys(manifest.release, ["gitCommit", "packageLock", "migrations", "compose", "networkManifests", "deployedImages"], "release")
  if (!/^[0-9a-f]{40}$/.test(manifest.release.gitCommit)) fail("git commit is invalid")
  validateFile(manifest.release.packageLock, "package lock")
  validateFile(manifest.release.compose, "compose")
  if (!Array.isArray(manifest.release.migrations) || !Array.isArray(manifest.release.networkManifests)) fail("release file lists are invalid")
  manifest.release.migrations.forEach((item, index) => validateFile(item, `migration ${index}`))
  manifest.release.networkManifests.forEach((item, index) => validateFile(item, `network manifest ${index}`))
  if (!Array.isArray(manifest.release.deployedImages) || JSON.stringify(manifest.release.deployedImages.map((item) => item.name)) !== JSON.stringify(imageNames)) fail("deployed images are invalid")
  for (const image of manifest.release.deployedImages) {
    exactKeys(image, ["name", "reference", "imageId"], "deployed image")
    if (!imageReferencePattern.test(image.reference) || !imageIdPattern.test(image.imageId)) fail("deployed image is invalid")
  }
  exactKeys(manifest.database, ["format", "dump", "countsSha256", "activeWorkCount", "tables"], "database")
  if (manifest.database.format !== "postgres-custom" || !shaPattern.test(manifest.database.countsSha256) || manifest.database.activeWorkCount !== "0") fail("database metadata is invalid")
  validateFile(manifest.database.dump, "database dump")
  if (!Array.isArray(manifest.database.tables)) fail("database tables are invalid")
  for (const table of manifest.database.tables) {
    exactKeys(table, ["table", "rowCount"], "database table")
    if (!expectedTables.includes(table.table) || !/^[0-9]+$/.test(table.rowCount)) fail("database table count is invalid")
  }
  if (JSON.stringify(manifest.database.tables.map((item) => item.table)) !== JSON.stringify(expectedTables)) fail("database tables are incomplete")
  exactKeys(manifest.artifacts, ["buckets"], "artifacts")
  if (!Array.isArray(manifest.artifacts.buckets) || JSON.stringify(manifest.artifacts.buckets.map((item) => item.name)) !== JSON.stringify(bucketNames)) fail("artifact buckets are invalid")
  for (const bucket of manifest.artifacts.buckets) {
    exactKeys(bucket, ["name", "objectCount", "totalByteLength", "objects"], "artifact bucket")
    if (!Array.isArray(bucket.objects) || !Number.isSafeInteger(bucket.objectCount) || !Number.isSafeInteger(bucket.totalByteLength)) fail("artifact bucket metadata is invalid")
    bucket.objects.forEach((item, index) => validateFile(item, `${bucket.name} object ${index}`))
    if (bucket.objectCount !== bucket.objects.length || bucket.totalByteLength !== bucket.objects.reduce((sum, item) => sum + item.byteLength, 0)) fail("artifact bucket totals are invalid")
  }
  return manifest
}

async function compareFile(path, expected, label) {
  const actual = await fileRecord(resolve(path, ".."), path)
  if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) fail(`${label} checksum or length differs`)
}

async function compareArtifacts(snapshot, bucketName, directory, manifest = undefined) {
  const record = manifest ?? await readManifest(snapshot)
  const bucket = record.artifacts.buckets.find((item) => item.name === bucketName)
  if (bucket === undefined) fail("artifact bucket is absent")
  const actual = await walkFiles(directory)
  if (JSON.stringify(actual) !== JSON.stringify(bucket.objects)) fail(`${bucketName} inventory differs`)
}

async function validate(snapshot) {
  const manifest = await readManifest(snapshot)
  const marker = (await readFile(resolve(snapshot, "COMPLETE"), "utf8")).trim()
  if (!shaPattern.test(marker) || marker !== await sha256(resolve(snapshot, "manifest.json"))) fail("completion marker is invalid")
  await compareFile(resolve(snapshot, manifest.database.dump.path), manifest.database.dump, "database dump")
  if (await sha256(resolve(snapshot, "database-counts.tsv")) !== manifest.database.countsSha256) fail("database counts checksum differs")
  if (JSON.stringify(await parseCounts(resolve(snapshot, "database-counts.tsv"))) !== JSON.stringify(manifest.database.tables)) fail("database counts differ")
  for (const name of bucketNames) await compareArtifacts(snapshot, name, resolve(snapshot, "buckets", name), manifest)
}

async function compatible(snapshot, repository, deployedImagesPath) {
  const manifest = await readManifest(snapshot)
  const current = await releaseRecord(repository, deployedImagesPath)
  if (JSON.stringify(current) !== JSON.stringify(manifest.release)) fail("snapshot release is incompatible with the current environment")
}

async function compareCounts(snapshot, countsPath) {
  const manifest = await readManifest(snapshot)
  if (JSON.stringify(await parseCounts(countsPath)) !== JSON.stringify(manifest.database.tables)) fail("restored database counts differ")
}

const [command, ...args] = process.argv.slice(2)

try {
  if (command === "capture" && args.length === 4) await capture(...args)
  else if (command === "validate" && args.length === 1) await validate(...args)
  else if (command === "compatible" && args.length === 3) await compatible(...args)
  else if (command === "compare-counts" && args.length === 2) await compareCounts(...args)
  else if (command === "compare-artifacts" && args.length === 3) await compareArtifacts(...args)
  else fail("invalid snapshot manifest command")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "snapshot manifest failed"}\n`)
  process.exitCode = 1
}
