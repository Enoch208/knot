import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
export const repository = resolve(import.meta.dirname, "../..")
export const manifestProgram = resolve(repository, "ops/backend/snapshot-manifest.mjs")
export const backupProgram = resolve(repository, "ops/backend/backup.sh")
export const restoreProgram = resolve(repository, "ops/backend/restore.sh")
export const acknowledgeProgram = resolve(repository, "ops/backend/acknowledge-maintenance-failure.sh")
export const imageReference = `registry.example/knot/backend@sha256:${"a".repeat(64)}`
export const imageId = `sha256:${"b".repeat(64)}`
const migrationsDirectory = resolve(repository, "packages/db/migrations")
export const migratedTableNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .flatMap((name) => [...readFileSync(resolve(migrationsDirectory, name), "utf8").matchAll(/^CREATE TABLE\s+([a-z][a-z0-9_]*)\s*\(/gm)])
  .map((match) => match[1] as string)
  .sort()
const imageNames = ["backend", "healthguard", "rangepilot", "gridquant", "yieldscout"]

export async function command(program: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return run(program, args, { cwd: repository, env: { ...process.env, ...env } })
}

export async function completeSnapshot(path: string, database = "target-database") {
  for (const bucket of ["knot-artifacts", "knot-deliverables"]) await mkdir(resolve(path, "buckets", bucket), { recursive: true, mode: 0o700 })
  await writeFile(resolve(path, "database.dump"), database)
  await writeFile(resolve(path, "database-counts.tsv"), migratedTableNames.map((name) => `${name}\t0`).join("\n") + "\n")
  await writeFile(resolve(path, "active-work-count.txt"), "0\n")
  await writeFile(resolve(path, "deployed-images.tsv"), imageNames.map((name) => `${name}\t${imageReference}\t${imageId}`).join("\n") + "\n")
  await writeFile(resolve(path, "buckets/knot-artifacts/result.json"), "target-artifact")
  await writeFile(resolve(path, "buckets/knot-deliverables/purchased.json"), "target-deliverable")
  await command(process.execPath, [manifestProgram, "capture", path, repository, resolve(path, "deployed-images.tsv"), "2026-09-09T16:00:00Z"])
  const manifest = await readFile(resolve(path, "manifest.json"))
  await writeFile(resolve(path, "COMPLETE"), `${createHash("sha256").update(manifest).digest("hex")}\n`)
}

export async function testEnvironment() {
  const root = await mkdtemp(resolve(tmpdir(), "knot-backup-test-"))
  const bin = resolve(root, "bin")
  const state = resolve(root, "state")
  const log = resolve(root, "docker.log")
  for (const bucket of ["knot-artifacts", "knot-deliverables"]) await mkdir(resolve(state, "buckets", bucket), { recursive: true })
  await mkdir(bin)
  await writeFile(resolve(state, "db-primary.dump"), "original-database")
  await writeFile(resolve(state, "buckets/knot-artifacts/result.json"), "original-artifact")
  await writeFile(resolve(state, "buckets/knot-deliverables/purchased.json"), "original-deliverable")
  const docker = `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$KNOT_TEST_LOG"
if [ "$1" = "inspect" ]; then
  container=
  for argument in "$@"; do container=$argument; done
  case "$*" in
    *Config.Image*) if [ "$container" = "\${KNOT_TEST_SELLER_IMAGE_DRIFT:-}" ]; then printf '%s\n' "registry.example/knot/drift@sha256:${"c".repeat(64)}"; else printf '%s\n' "$KNOT_TEST_IMAGE_REFERENCE"; fi ;;
    *State.Health*) if [ "\${KNOT_TEST_HEALTH_FAILURE:-0}" = 1 ]; then printf '%s\n' unhealthy; else printf '%s\n' healthy; fi ;;
    *State.Running*) if [ -e "$KNOT_TEST_STATE/writers-stopped" ]; then printf '%s\n' false; else printf '%s\n' true; fi ;;
    *) if [ "$container" = "\${KNOT_TEST_SELLER_IMAGE_DRIFT:-}" ]; then printf '%s\n' "sha256:${"d".repeat(64)}"; else printf '%s\n' "$KNOT_TEST_IMAGE_ID"; fi ;;
  esac
  exit 0
fi
shift
project_directory=
while [ "$1" = "--project-directory" ] || [ "$1" = "--file" ]; do
  if [ "$1" = "--project-directory" ]; then project_directory=$2; fi
  shift 2
done
action=$1
shift
case "$action" in
  ps)
    if [ -e "$KNOT_TEST_STATE/writers-stopped" ]; then case "$*" in *--all*) ;; *) exit 0 ;; esac; fi
    case "$*" in *api*) printf '%s\n' api-container ;; *worker*) printf '%s\n' worker-container ;; *) printf '%s\n' "$(basename "$project_directory")-container" ;; esac
    ;;
  stop) : > "$KNOT_TEST_STATE/writers-stopped" ;;
  start) if [ "\${KNOT_TEST_START_FAILURE:-0}" = 1 ]; then exit 1; else rm -f "$KNOT_TEST_STATE/writers-stopped"; fi ;;
  exec)
    database=primary
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--env" ]; then database=\${2#KNOT_DATABASE_NAME=}; shift 2; else shift; fi
    done
    invocation=$(tail -n 1 "$KNOT_TEST_LOG")
    case "$invocation" in
      *pg_dump*) cat "$KNOT_TEST_STATE/db-primary.dump" ;;
      *'printf "%s"'*) printf '%s' primary ;;
      *'SELECT (SELECT count'*)
        if grep -q ACTIVE "$KNOT_TEST_STATE/db-$database.dump" 2>/dev/null; then printf '%s\n' 1; else printf '%s\n' "\${KNOT_TEST_ACTIVE_COUNT:-0}"; fi
        ;;
      *'SELECT table_name'*)
        case "$invocation" in *seller_requests*) exit 1 ;; esac
        for table in ${migratedTableNames.join(" ")}; do
          printf '%s' "$invocation" | grep -F "'$table'" >/dev/null || exit 1
          printf '%s\t0\n' "$table"
        done
        ;;
      *pg_restore*) cat > "$KNOT_TEST_STATE/db-$database.dump" ;;
      *dropdb*) : > "$KNOT_TEST_STATE/db-$database.dump" ;;
      *) ;;
    esac
    ;;
  run)
    bucket=
    source_bucket=
    volume=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --env) case "$2" in KNOT_BUCKET=*) bucket=\${2#KNOT_BUCKET=} ;; KNOT_SOURCE_BUCKET=*) source_bucket=\${2#KNOT_SOURCE_BUCKET=} ;; esac; shift 2 ;;
        --volume) volume=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    invocation=$(tail -n 1 "$KNOT_TEST_LOG")
    source_path=\${volume%%:*}
    case "$invocation" in
      *'mc rb'*) rm -rf "$KNOT_TEST_STATE/buckets/$bucket" ;;
      *'/readback'*)
        if [ "\${KNOT_TEST_FAIL_ROLLBACK_READBACK:-0}" = 1 ]; then case "$source_path" in *rollback-*) exit 1 ;; esac; fi
        mkdir -p "$source_path"; cp -R "$KNOT_TEST_STATE/buckets/$bucket/." "$source_path/"
        ;;
      *'/backup:ro'*)
        mkdir -p "$KNOT_TEST_STATE/buckets/$bucket"
        case "$bucket" in "\${KNOT_TEST_FAIL_SHADOW_BUCKET:-no-match}"*) exit 1 ;; esac
        if [ "\${KNOT_TEST_FAIL_ROLLBACK:-0}" = 1 ]; then case "$source_path" in *private-rollback*) exit 1 ;; esac; fi
        if [ "$bucket" = "knot-artifacts" ] && [ "$source_path" = "\${KNOT_TEST_TARGET_SNAPSHOT:-}" ] && [ ! -e "$KNOT_TEST_STATE/failed-once" ]; then : > "$KNOT_TEST_STATE/failed-once"; exit 1; fi
        find "$KNOT_TEST_STATE/buckets/$bucket" -mindepth 1 -delete 2>/dev/null || true
        cp -R "$source_path/buckets/$source_bucket/." "$KNOT_TEST_STATE/buckets/$bucket/"
        ;;
      *) ;;
    esac
    ;;
esac
`
  await writeFile(resolve(bin, "docker"), docker)
  await chmod(resolve(bin, "docker"), 0o700)
  await writeFile(resolve(bin, "date"), "#!/bin/sh\ncase \"$*\" in *%Y%m%d*) printf '%s\\n' 20260909T160000Z ;; *) printf '%s\\n' 2026-09-09T16:00:00Z ;; esac\n")
  await chmod(resolve(bin, "date"), 0o700)
  return {
    root, state, log,
    lock: resolve(root, "maintenance.lock"),
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      KNOT_TEST_LOG: log,
      KNOT_TEST_STATE: state,
      KNOT_TEST_IMAGE_REFERENCE: imageReference,
      KNOT_TEST_IMAGE_ID: imageId,
      KNOT_OPS_WAIT_ATTEMPTS: "1",
      KNOT_MAINTENANCE_LOCK_DIRECTORY: resolve(root, "maintenance.lock"),
    },
  }
}
