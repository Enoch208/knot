import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { hashEvmTransactionIntent, type EvmTransactionIntent } from "../../packages/chain/src/transaction-intent.ts"
import { createDatabasePool, migrateDatabase } from "../../packages/db/src/index.ts"

const execute = promisify(execFile)
const repository = resolve(import.meta.dirname, "../..")
const backupProgram = resolve(repository, "ops/backend/backup.sh")
const tool = (name: string): string | null => {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : null
}
const postgresTools = {
  initdb: tool("initdb"),
  pgCtl: tool("pg_ctl"),
  createdb: tool("createdb"),
}
const unavailable = Object.values(postgresTools).some((path) => path === null)

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveReady)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("disposable PostgreSQL port is unavailable")
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()))
  return address.port
}

async function fakeDocker(path: string): Promise<void> {
  const program = `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$KNOT_TEST_LOG"
if [ "$1" = inspect ]; then
  case "$*" in
    *Config.Image*) printf '%s\n' "$KNOT_TEST_IMAGE_REFERENCE" ;;
    *State.Health*) printf '%s\n' healthy ;;
    *State.Running*) if [ -e "$KNOT_TEST_STATE/writers-stopped" ]; then printf '%s\n' false; else printf '%s\n' true; fi ;;
    *) printf '%s\n' "$KNOT_TEST_IMAGE_ID" ;;
  esac
  exit 0
fi
shift
while [ "$1" = --project-directory ] || [ "$1" = --file ]; do shift 2; done
action=$1
shift
case "$action" in
  ps)
    case "$*" in *api*) printf '%s\n' api-container ;; *worker*) printf '%s\n' worker-container ;; *) printf '%s\n' seller-container ;; esac
    ;;
  stop) : > "$KNOT_TEST_STATE/writers-stopped" ;;
  start) rm -f "$KNOT_TEST_STATE/writers-stopped" ;;
  exec)
    database=$KNOT_TEST_DATABASE
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -T) shift ;;
        --env) database=\${2#KNOT_DATABASE_NAME=}; shift 2 ;;
        *) break ;;
      esac
    done
    service=$1
    shift
    if [ "$service" = api ]; then exit 0; fi
    export POSTGRES_USER="$KNOT_TEST_DATABASE_USER"
    export POSTGRES_DB="$KNOT_TEST_DATABASE"
    export PGHOST=127.0.0.1
    export PGPORT="$KNOT_TEST_DATABASE_PORT"
    export KNOT_DATABASE_NAME="$database"
    exec "$@"
    ;;
esac
`
  await writeFile(path, program, { mode: 0o700 })
  await chmod(path, 0o700)
}

test("quiesced logical backup refuses a queued PREPARED recovery and leaves it intact", { skip: unavailable }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "knot-active-recovery-snapshot-"))
  const data = resolve(root, "postgres")
  const socketLog = resolve(root, "postgres.log")
  const bin = resolve(root, "bin")
  const state = resolve(root, "state")
  const dockerLog = resolve(root, "docker.log")
  const lock = resolve(root, "maintenance.lock")
  const database = "knot_active_recovery"
  const databaseUser = "knot_drill"
  const port = await availablePort()
  let started = false
  let pool: ReturnType<typeof createDatabasePool> | null = null
  try {
    await mkdir(bin)
    await mkdir(state)
    await fakeDocker(resolve(bin, "docker"))
    await execute(postgresTools.initdb as string, ["--pgdata", data, "--username", databaseUser, "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"])
    await execute(postgresTools.pgCtl as string, ["--pgdata", data, "--log", socketLog, "--options", `-h 127.0.0.1 -p ${port}`, "--wait", "start"])
    started = true
    await execute(postgresTools.createdb as string, ["--host", "127.0.0.1", "--port", String(port), "--username", databaseUser, database])
    pool = createDatabasePool(`postgresql://${databaseUser}@127.0.0.1:${port}/${database}`, { max: 2 })
    await migrateDatabase(pool)

    const address = "0x1111111111111111111111111111111111111111"
    const digest = `0x${"1".repeat(64)}`
    const taskId = randomUUID()
    const agentId = randomUUID()
    const quoteId = randomUUID()
    const jobId = randomUUID()
    const sessionId = randomUUID()
    const actionId = randomUUID()
    const intent: EvmTransactionIntent = {
      schemaVersion: "knot.evm-transaction-intent/1",
      taskId,
      actionSequence: 0,
      semanticAction: "fund",
      signerAddress: address,
      accountAddress: address,
      chainId: 97,
      nonce: "42",
      destination: address,
      valueUnits: "0",
      calldataHash: digest,
      gasLimit: "21000",
      gasPriceUnits: "1",
    }
    await pool.query("INSERT INTO agents (id, chain_id, registry, agent_id, owner_address, operator_relation, metadata_hash, status) VALUES ($1, 97, $2, 1, $2, 'EXTERNAL', $3, 'HIREABLE')", [agentId, address, digest])
    await pool.query("INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id, payment_chain_id, input_hash, task_spec, access_scope, deadline_at) VALUES ($1, $2, 'knot.task/1', 'yield', 'analysis', 97, 56, 97, $3, '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour')", [taskId, address, digest])
    await pool.query("INSERT INTO quotes (id, task_id, provider_agent_id, issuer_domain, quote_nonce, task_hash, chain_id, token, amount_units, token_decimals, binding, expires_at) VALUES ($1, $2, $3, 'drill.knot', 'drill-quote', $4, 97, $5, 1, 18, '{}'::jsonb, now() + interval '1 hour')", [quoteId, taskId, agentId, digest, address])
    await pool.query("INSERT INTO jobs (id, buyer, endpoint, idempotency_key, task_id, quote_id, work_state, financial_state) VALUES ($1, $2, 'https://drill.invalid', $3, $4, $5, 'OUTPUT_CHECKED', 'PAID')", [jobId, address, randomUUID(), taskId, quoteId])
    await pool.query("INSERT INTO sessions (id, owner_address, chain_id, permissions, secret_reference, epoch, expires_at) VALUES ($1, $2, 97, '{}'::jsonb, 'drill-only', 0, now() + interval '1 hour')", [sessionId, address])
    await pool.query("INSERT INTO chain_actions (id, job_id, session_id, task_id, action_sequence, semantic_action, signer_address, account_address, chain_id, nonce, request_hash, transaction_intent, state) VALUES ($1, $2, $3, $4, 0, 'fund', $5, $5, 97, 42, $6, $7::jsonb, 'PREPARED')", [actionId, jobId, sessionId, taskId, address, hashEvmTransactionIntent(intent), JSON.stringify(intent)])

    const eligibleBefore = await pool.query("SELECT count(*) AS count FROM jobs WHERE (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()) AND EXISTS (SELECT 1 FROM chain_actions WHERE chain_actions.job_id = jobs.id AND chain_actions.state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND chain_actions.nonce IS NOT NULL AND chain_actions.relay_intent_id IS NULL AND chain_actions.transaction_intent IS NOT NULL AND (chain_actions.state <> 'SUBMITTED' OR chain_actions.transaction_hash IS NOT NULL))")
    assert.equal(eligibleBefore.rows[0]?.count, "1")

    const destination = resolve(root, "backups")
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      KNOT_TEST_LOG: dockerLog,
      KNOT_TEST_STATE: state,
      KNOT_TEST_DATABASE: database,
      KNOT_TEST_DATABASE_USER: databaseUser,
      KNOT_TEST_DATABASE_PORT: String(port),
      KNOT_TEST_IMAGE_REFERENCE: `registry.example/knot/backend@sha256:${"a".repeat(64)}`,
      KNOT_TEST_IMAGE_ID: `sha256:${"b".repeat(64)}`,
      KNOT_OPS_WAIT_ATTEMPTS: "1",
      KNOT_MAINTENANCE_LOCK_DIRECTORY: lock,
    }
    await assert.rejects(execute(backupProgram, [destination], { cwd: repository, env: environment }), /logical snapshot refused: 1 active jobs or chain actions require reconciliation/)
    const actionAfter = await pool.query("SELECT state, version, transaction_hash FROM chain_actions WHERE id = $1", [actionId])
    assert.deepEqual(actionAfter.rows[0], { state: "PREPARED", version: 0, transaction_hash: null })
    assert.deepEqual(await readdir(destination), [])
    await assert.rejects(stat(lock))
    await assert.rejects(stat(resolve(state, "writers-stopped")))
  } finally {
    if (pool !== null) await pool.end()
    if (started) await execute(postgresTools.pgCtl as string, ["--pgdata", data, "--mode", "immediate", "--wait", "stop"])
    await rm(root, { recursive: true, force: true })
  }
})
