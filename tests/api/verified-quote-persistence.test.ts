import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Pool } from "pg"
import { PgVerifiedQuotePersistence } from "../../apps/api/src/verified-quote-persistence.ts"

class AdvisoryLockClient {
  readonly queries: string[] = []
  releaseValue: Error | boolean | undefined
  failUnlock = false

  async query(text: string): Promise<{ rows: unknown[] }> {
    this.queries.push(text)
    if (this.failUnlock && text.startsWith("SELECT pg_advisory_unlock")) {
      throw new Error("unlock failed")
    }
    return { rows: [] }
  }

  release(value?: Error | boolean): void {
    this.releaseValue = value
  }
}

const persistence = (client: AdvisoryLockClient): PgVerifiedQuotePersistence =>
  new PgVerifiedQuotePersistence({ connect: async () => client } as unknown as Pool)

describe("verified quote advisory lock lifecycle", () => {
  it("releases a healthy client only after unlocking the service request", async () => {
    const client = new AdvisoryLockClient()
    const result = await persistence(client).withServiceRequestLock(
      "0x1111111111111111111111111111111111111111",
      "request_1",
      async () => "complete",
    )
    assert.equal(result, "complete")
    assert.deepEqual(client.queries, [
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
    ])
    assert.equal(client.releaseValue, false)
  })

  it("destroys a pooled session when unlock fails so a session lock cannot leak", async () => {
    const client = new AdvisoryLockClient()
    client.failUnlock = true
    const result = await persistence(client).withServiceRequestLock(
      "0x1111111111111111111111111111111111111111",
      "request_1",
      async () => "complete",
    )
    assert.equal(result, "complete")
    assert.equal(client.releaseValue, true)
  })

  it("preserves the operation error while destroying a session whose unlock also fails", async () => {
    const client = new AdvisoryLockClient()
    client.failUnlock = true
    const operationError = new Error("operation failed")
    await assert.rejects(
      () => persistence(client).withServiceRequestLock(
        "0x1111111111111111111111111111111111111111",
        "request_1",
        async () => {
          throw operationError
        },
      ),
      (error: unknown) => error === operationError,
    )
    assert.equal(client.releaseValue, true)
  })
})
