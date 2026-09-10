import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Pool } from "pg"
import {
  EndpointObservationRepository,
  IdempotencyConflictError,
  type AppendNegotiationEndpointObservationInput,
} from "../../packages/db/src/index.ts"

const observedAt = new Date("2026-09-09T20:00:00.000Z")

const input = (): AppendNegotiationEndpointObservationInput => ({
  id: "endpoint_range_request_1",
  agentRecordId: "owned_rangepilot_2297",
  endpoint: "https://knot-range.truematchx.com",
  latencyMilliseconds: 123,
  safeDetails: {
    schemaVersion: "knot.owned-seller-endpoint-observation/1",
    sellerKey: "rangepilot",
    transportVersion: "knot.owned-seller-client/1",
    httpStatus: 200,
    responseByteLength: 1024,
    responseSha256: `0x${"12".repeat(32)}`,
  },
  observedAt,
})

class MemoryPool {
  row: Record<string, unknown> | null = null

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (text.startsWith("INSERT INTO endpoint_observations")) {
      if (this.row !== null) return { rows: [] }
      this.row = {
        id: values[0],
        agent_id: values[1],
        endpoint: values[2],
        request_type: "negotiate",
        result: "SUCCESS",
        latency_milliseconds: values[3],
        safe_details: JSON.parse(String(values[4])) as unknown,
        observed_at: values[5],
        created_at: observedAt,
      }
      return { rows: [this.row] }
    }
    if (text === "SELECT * FROM endpoint_observations WHERE id = $1") {
      const row = this.row
      if (row !== null && row.id === values[0]) return { rows: [row] }
      return { rows: [] }
    }
    throw new Error("unexpected endpoint observation query")
  }
}

describe("EndpointObservationRepository", () => {
  it("stores only sanitized successful negotiation metadata and retries exactly", async () => {
    const pool = new MemoryPool()
    const repository = new EndpointObservationRepository(pool as unknown as Pool)
    const first = await repository.appendNegotiationSuccess(input())
    const second = await repository.appendNegotiationSuccess(input())
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.deepEqual(second.record, first.record)
    assert.deepEqual(Object.keys(first.record.safeDetails).sort(), [
      "httpStatus",
      "responseByteLength",
      "responseSha256",
      "schemaVersion",
      "sellerKey",
      "transportVersion",
    ])
    assert.doesNotMatch(JSON.stringify(first.record), /authorization|bearer|clientSecret|task_description/i)
  })

  it("accepts both exact spellings of an HTTPS root origin", async () => {
    const slashless = await new EndpointObservationRepository(new MemoryPool() as unknown as Pool)
      .appendNegotiationSuccess(input())
    const withSlash = await new EndpointObservationRepository(new MemoryPool() as unknown as Pool)
      .appendNegotiationSuccess({ ...input(), endpoint: `${input().endpoint}/` })
    assert.equal(slashless.record.endpoint, "https://knot-range.truematchx.com")
    assert.equal(withSlash.record.endpoint, "https://knot-range.truematchx.com/")
  })

  it("rejects conflicting retries and malformed metadata", async () => {
    const pool = new MemoryPool()
    const repository = new EndpointObservationRepository(pool as unknown as Pool)
    await repository.appendNegotiationSuccess(input())
    await assert.rejects(
      () => repository.appendNegotiationSuccess({ ...input(), latencyMilliseconds: 124 }),
      IdempotencyConflictError,
    )
    await assert.rejects(
      () => repository.appendNegotiationSuccess({
        ...input(),
        id: "different",
        safeDetails: { ...input().safeDetails, responseByteLength: 0 },
      }),
      RangeError,
    )
  })
})
