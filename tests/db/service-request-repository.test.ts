import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { deflateRawSync } from "node:zlib"
import type { Pool } from "pg"
import {
  COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX,
  prepareServiceRequest,
  type ServiceRequestEnvelope,
} from "../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../packages/contracts/src/task.ts"
import {
  ServiceRequestRepository,
  TaskDeadlineElapsedError,
} from "../../packages/db/src/index.ts"

const buyer = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
const endpoint = "https://knot-range.truematchx.com/"
const task = taskSpec.parse(JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as unknown)
const requestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
const envelope = (): ServiceRequestEnvelope => ({
  schemaVersion: "knot.service-request/1",
  task,
  request: {
    mediaType: "application/json",
    schemaVersion: "knot.rangepilot.request/1",
    bytesBase64url: requestBytes.toString("base64url"),
  },
  transport: "deflate-base64url",
})

const sha256 = (value: Uint8Array): `0x${string}` =>
  `0x${createHash("sha256").update(value).digest("hex")}`

class ServiceRequestPool {
  readonly deadline: Date
  readonly records = new Map<string, Record<string, unknown>>()
  queryCount = 0

  constructor(deadline: Date) {
    this.deadline = deadline
  }

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.queryCount += 1
    if (text.startsWith("INSERT INTO service_requests")) {
      const requestedAt = values[16] as Date
      const key = this.key(String(values[1]), String(values[2]), String(values[3]))
      if (requestedAt.getTime() >= this.deadline.getTime() || this.records.has(key)) return { rows: [] }
      const request = Buffer.from(values[9] as Uint8Array)
      const row = {
        id: String(values[0]),
        buyer: String(values[1]),
        endpoint: String(values[2]),
        idempotency_key: String(values[3]),
        task_id: String(values[4]),
        task_spec_binding: JSON.parse(String(values[5])) as unknown,
        category: String(values[6]),
        request_schema_version: String(values[7]),
        transport: String(values[8]),
        request_bytes: request,
        request_sha256: sha256(request),
        request_keccak256: String(values[10]),
        task_description: String(values[11]),
        task_description_sha256: String(values[12]),
        snapshot_id: String(values[13]),
        task_input_hash: String(values[14]),
        input_binding: String(values[15]),
        created_at: requestedAt,
      }
      this.records.set(key, row)
      return { rows: [row] }
    }
    if (text.startsWith("SELECT * FROM service_requests WHERE buyer")) {
      const row = this.records.get(this.key(String(values[0]), String(values[1]), String(values[2])))
      return { rows: row ? [row] : [] }
    }
    if (text.startsWith("SELECT deadline_at FROM tasks")) {
      return { rows: [{ deadline_at: this.deadline }] }
    }
    if (text.startsWith("SELECT * FROM service_requests WHERE id")) {
      const row = [...this.records.values()].find((record) =>
        record.id === values[0] && record.buyer === String(values[1]).toLowerCase())
      return { rows: row ? [row] : [] }
    }
    throw new Error("unexpected service request repository query")
  }

  private key(owner: string, target: string, idempotencyKey: string): string {
    return `${owner.toLowerCase()}\n${target}\n${idempotencyKey}`
  }
}

describe("ServiceRequestRepository intake boundaries", () => {
  it("persists the exact compressed task description", async () => {
    const pool = new ServiceRequestPool(new Date("2030-01-01T00:00:00Z"))
    const repository = new ServiceRequestRepository(pool as unknown as Pool)
    const result = await repository.create({
      id: "request_compressed",
      buyer,
      endpoint,
      idempotencyKey: "request_compressed",
      envelope: envelope(),
    })
    assert.equal(result.created, true)
    assert.equal(result.record.taskDescription, prepareServiceRequest(envelope(), buyer).taskDescription)
    assert.match(result.record.taskDescription, /^knot-json-deflate-base64url\/1:/)
  })

  it("reads the exact stored compressed representation without requiring zlib re-encoding equality", async () => {
    const pool = new ServiceRequestPool(new Date("2030-01-01T00:00:00Z"))
    const repository = new ServiceRequestRepository(pool as unknown as Pool)
    const input = {
      id: "request_historical_compression",
      buyer,
      endpoint,
      idempotencyKey: "request_historical_compression",
      envelope: envelope(),
    }
    await repository.create(input)
    const row = [...pool.records.values()][0]
    assert.ok(row)
    const historicalDescription = `${COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX}${deflateRawSync(requestBytes, { level: 1 }).toString("base64url")}`
    assert.notEqual(historicalDescription, prepareServiceRequest(envelope(), buyer).taskDescription)
    row.task_description = historicalDescription
    row.task_description_sha256 = sha256(Buffer.from(historicalDescription, "utf8"))
    const restored = await repository.get(input.id, buyer)
    assert.equal(restored?.taskDescription, historicalDescription)
    assert.deepEqual(restored?.requestBytes, requestBytes)
  })

  it("refuses endpoints rejected by the outbound address policy before database access", async () => {
    const pool = new ServiceRequestPool(new Date("2030-01-01T00:00:00Z"))
    const repository = new ServiceRequestRepository(pool as unknown as Pool)
    for (const unsafe of [
      "https://localhost/",
      "https://seller.internal/",
      "https://127.0.0.1/",
      "https://169.254.169.254/",
      "https://[::1]/",
      "https://seller.example:444/",
      "https://seller.example/#fragment",
    ]) {
      await assert.rejects(
        () => repository.create({ id: "request_unsafe", buyer, endpoint: unsafe, idempotencyKey: "request_unsafe", envelope: envelope() }),
        RangeError,
      )
    }
    assert.equal(pool.queryCount, 0)
  })

  it("allows an exact retry and read after deadline but refuses a genuinely new request", async () => {
    let now = new Date("2026-09-09T12:00:00Z")
    const pool = new ServiceRequestPool(new Date("2026-09-09T12:01:01Z"))
    const repository = new ServiceRequestRepository(pool as unknown as Pool, () => now)
    const input = {
      id: "request_before_deadline",
      buyer,
      endpoint,
      idempotencyKey: "request_before_deadline",
      envelope: envelope(),
    }
    const created = await repository.create(input)
    assert.equal(created.created, true)

    now = new Date("2026-09-09T12:02:00Z")
    const retried = await repository.create(input)
    const read = await repository.get(input.id, buyer.toUpperCase())
    assert.equal(retried.created, false)
    assert.deepEqual(retried.record, created.record)
    assert.deepEqual(read, created.record)
    await assert.rejects(
      () => repository.create({
        ...input,
        id: "request_after_deadline",
        idempotencyKey: "request_after_deadline",
      }),
      TaskDeadlineElapsedError,
    )
    assert.equal(pool.records.size, 1)
  })

  it("keeps a conflicting same-key retry conflicting after deadline", async () => {
    let now = new Date("2026-09-09T12:00:00Z")
    const pool = new ServiceRequestPool(new Date("2026-09-09T12:01:01Z"))
    const repository = new ServiceRequestRepository(pool as unknown as Pool, () => now)
    const input = {
      id: "request_conflict",
      buyer,
      endpoint,
      idempotencyKey: "request_conflict",
      envelope: envelope(),
    }
    await repository.create(input)
    now = new Date("2026-09-09T12:02:00Z")
    await assert.rejects(
      () => repository.create({ ...input, id: "different_request" }),
      /idempotency key is already bound/,
    )
  })
})
