import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Pool, PoolClient } from "pg"

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../migrations")
const advisoryLockId = 4_916_796_248

interface AppliedMigration {
  name: string
  checksum: string
}

const loadMigrations = async (): Promise<AppliedMigration[]> => {
  const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(migrationDirectory, name), "utf8")
      return { name, checksum: createHash("sha256").update(sql).digest("hex") }
    }),
  )
}

const applyMigration = async (client: PoolClient, migration: AppliedMigration): Promise<void> => {
  const existing = await client.query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE name = $1",
    [migration.name],
  )
  if (existing.rowCount === 1) {
    if (existing.rows[0]?.checksum !== migration.checksum) {
      throw new Error(`migration checksum mismatch: ${migration.name}`)
    }
    return
  }
  const sql = await readFile(join(migrationDirectory, migration.name), "utf8")
  await client.query("BEGIN")
  try {
    await client.query(sql)
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      migration.checksum,
    ])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

export const migrateDatabase = async (pool: Pool): Promise<void> => {
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLockId])
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    )
    for (const migration of await loadMigrations()) {
      await applyMigration(client, migration)
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockId]).catch(() => undefined)
    client.release()
  }
}
