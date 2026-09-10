import assert from "node:assert/strict"
import test from "node:test"
import { Pool } from "pg"

const connectionString = process.env.KNOT_TEST_DATABASE_URL?.trim()

const BUYER = "0x71b1373fcdffbd669b85d39b2cfb37ffb9c62930"
const DESCRIPTION = "knot-json-base64url/1:3q2-796tvu_erb7v"

async function seed(pool: Pool, suffix: string, retention: string): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (id, buyer, schema_version, category, capability, identity_chain_id, data_chain_id,
       payment_chain_id, input_hash, task_spec, access_scope, deadline_at)
     VALUES ($1, $2, 'knot.task/1', 'grid', 'analysis', 97, 56, 97, $3,
       jsonb_build_object('snapshotId', 'snap_' || $4), '{}'::jsonb, now() + interval '1 day')
     ON CONFLICT DO NOTHING`,
    [`task_${suffix}`, BUYER, `0x${"c".repeat(64)}`, suffix],
  )
  await pool.query(
    `INSERT INTO service_requests (id, buyer, endpoint, idempotency_key, task_id, task_spec_binding, category,
       request_schema_version, transport, request_bytes, request_keccak256, task_description,
       task_description_sha256, snapshot_id, task_input_hash, input_binding, retention_until)
     VALUES ($1, $2, 'https://knot-grid.truematchx.com', $3, $4,
       jsonb_build_object('snapshotId', 'snap_' || $5), 'grid', 'knot.gridquant.request/2', 'base64url',
       decode('deadbeefdeadbeefdeadbeef','hex'), $6, $7,
       '0x' || encode(sha256(convert_to($7, 'UTF8')), 'hex'), 'snap_' || $5, $6, 'EXACT_REQUEST_BYTES',
       now() + $8::interval)`,
    [`sr_${suffix}`, BUYER, `idem_${suffix}`, `task_${suffix}`, suffix, `0x${"c".repeat(64)}`, DESCRIPTION, retention],
  )
}

const refused = async (pool: Pool, sql: string, params: unknown[] = []): Promise<string> => {
  try {
    await pool.query(sql, params)
  } catch (error) {
    return (error as Error).message
  }
  return assert.fail(`expected a refusal for: ${sql}`)
}

if (!connectionString) {
  test("service request erasure", { skip: "KNOT_TEST_DATABASE_URL is required" }, () => undefined)
} else {
  test("retained payloads are erasable only through the sanctioned path", async (t) => {
    const pool = new Pool({ connectionString })
    t.after(async () => {
      await pool.query("DELETE FROM tasks WHERE id LIKE 'task_ret%'").catch(() => undefined)
      await pool.end()
    })

    await seed(pool, "ret1", "-1 hour")
    const before = await pool.query<{ sha: string; bytes: number }>(
      "SELECT request_sha256 AS sha, octet_length(request_bytes) AS bytes FROM service_requests WHERE id = 'sr_ret1'",
    )
    const original = before.rows[0]
    assert.ok(original && original.bytes > 1)

    assert.match(
      await refused(pool, "UPDATE service_requests SET request_bytes = decode('00','hex') WHERE id = 'sr_ret1'"),
      /append-only/,
    )
    assert.match(await refused(pool, "DELETE FROM service_requests WHERE id = 'sr_ret1'"), /append-only/)
    assert.match(
      await refused(
        pool,
        "UPDATE service_requests SET erased_at = now(), erased_request_sha256 = request_sha256 WHERE id = 'sr_ret1'",
      ),
      /append-only/,
      "an erasure that keeps the payload must be refused",
    )

    const erased = await pool.query<{ erased_id: string; preserved_sha256: string }>(
      "SELECT * FROM knot_erase_expired_service_requests(now())",
    )
    assert.deepEqual(erased.rows.map((row) => row.erased_id), ["sr_ret1"])
    assert.equal(erased.rows[0]?.preserved_sha256, original.sha)

    const after = await pool.query<{ bytes: number; preserved: string; erased: boolean; keccak: string }>(
      `SELECT octet_length(request_bytes) AS bytes, erased_request_sha256 AS preserved,
              (erased_at IS NOT NULL) AS erased, request_keccak256 AS keccak
         FROM service_requests WHERE id = 'sr_ret1'`,
    )
    const row = after.rows[0]
    assert.ok(row)
    assert.equal(row.bytes, 1, "the payload must be reduced to a single tombstone byte")
    assert.equal(row.preserved, original.sha, "the original digest must survive erasure")
    assert.equal(row.erased, true)
    assert.equal(row.keccak, `0x${"c".repeat(64)}`, "the request binding must survive erasure")

    const second = await pool.query("SELECT * FROM knot_erase_expired_service_requests(now())")
    assert.equal(second.rowCount, 0, "erasure must not repeat")
  })

  test("a payload inside its retention window is never erased", async (t) => {
    const pool = new Pool({ connectionString })
    t.after(async () => {
      await pool.query("DELETE FROM tasks WHERE id LIKE 'task_ret%'").catch(() => undefined)
      await pool.end()
    })

    await seed(pool, "ret2", "1 day")
    const result = await pool.query("SELECT * FROM knot_erase_expired_service_requests(now())")
    assert.equal(result.rowCount, 0)

    const row = await pool.query<{ bytes: number }>(
      "SELECT octet_length(request_bytes) AS bytes FROM service_requests WHERE id = 'sr_ret2'",
    )
    assert.ok((row.rows[0]?.bytes ?? 0) > 1, "a retained payload must keep its bytes")
  })
}
