import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { Pool } from "pg"
import { PgApiStore } from "../../apps/api/src/pg-store.ts"

interface StatusRow {
  artifacts: string | null
  identity_observations: string | null
  identity_observation_column: boolean
  jobs: string | null
  migration_0011: boolean
  migration_0012: boolean
  service_requests: string | null
  tasks: string | null
  verified_quotes: string | null
}

const available = (): StatusRow => ({
  artifacts: "artifacts",
  identity_observations: "erc8004_identity_observations",
  identity_observation_column: true,
  jobs: "jobs",
  migration_0011: true,
  migration_0012: true,
  service_requests: "service_requests",
  tasks: "tasks",
  verified_quotes: "verified_quotes",
})

class StatusPool {
  readonly queries: string[] = []
  row: StatusRow = available()

  async query(sql: string): Promise<{ rows: StatusRow[] }> {
    this.queries.push(sql)
    return { rows: [this.row] }
  }
}

const store = (pool: StatusPool): PgApiStore => new PgApiStore(pool as unknown as Pool)

describe("API database readiness", () => {
  test("requires the immutable identity table, verified-quote link, and both migrations", async () => {
    const pool = new StatusPool()
    await store(pool).status()
    assert.equal(pool.queries.length, 1)
    assert.match(pool.queries[0]!, /erc8004_identity_observations/)
    assert.match(pool.queries[0]!, /identity_observation_id/)
    assert.match(pool.queries[0]!, /0011_erc8004_identity_observations\.sql/)
    assert.match(pool.queries[0]!, /0012_verified_quote_identity_observation\.sql/)
  })

  test("fails closed when an identity schema prerequisite is absent", async () => {
    for (const key of ["identity_observations", "identity_observation_column", "migration_0011", "migration_0012"] as const) {
      const pool = new StatusPool()
      pool.row = { ...pool.row, [key]: key === "identity_observations" ? null : false }
      await assert.rejects(store(pool).status(), /required database schema is unavailable/)
    }
  })
})
