import assert from "node:assert/strict"
import { test } from "node:test"
import {
  RetentionPolicyError,
  assertErasureRecord,
  decideErasure,
  retentionDeadline,
  selectErasable,
  type RetainedRequest,
} from "../../packages/db/src/retention-policy.ts"

const NOW = new Date("2026-09-10T12:00:00.000Z")

const request = (overrides: Partial<RetainedRequest> = {}): RetainedRequest => ({
  id: "sr_1",
  retentionUntil: new Date("2026-09-10T11:00:00.000Z"),
  erasedAt: null,
  requestByteLength: 2048,
  ...overrides,
})

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof RetentionPolicyError, `expected RetentionPolicyError, got ${String(error)}`)
    return error.code
  }
  return assert.fail("expected a refusal")
}

test("an elapsed retention deadline makes a payload erasable", () => {
  const decision = decideErasure(request(), NOW)
  assert.equal(decision.erase, true)
  assert.equal(decision.reason, "retention elapsed")
})

test("a payload whose retention has not elapsed is never erased", () => {
  const decision = decideErasure(request({ retentionUntil: new Date("2026-09-10T12:00:01.000Z") }), NOW)
  assert.equal(decision.erase, false)
  assert.match(decision.reason, /not elapsed/)
})

test("a record with no retention deadline is retained rather than assumed expired", () => {
  const decision = decideErasure(request({ retentionUntil: null }), NOW)
  assert.equal(decision.erase, false)
  assert.match(decision.reason, /no retention deadline/)
})

test("an already erased record is never erased twice", () => {
  const decision = decideErasure(request({ erasedAt: new Date("2026-09-10T11:30:00.000Z") }), NOW)
  assert.equal(decision.erase, false)
  assert.match(decision.reason, /already erased/)
})

test("a payload already reduced to a tombstone is left alone", () => {
  const decision = decideErasure(request({ requestByteLength: 1 }), NOW)
  assert.equal(decision.erase, false)
  assert.match(decision.reason, /tombstone/)
})

test("selection separates erasable records from retained ones without dropping any", () => {
  const inputs = [
    request({ id: "a" }),
    request({ id: "b", retentionUntil: new Date("2026-09-11T00:00:00.000Z") }),
    request({ id: "c", erasedAt: NOW }),
    request({ id: "d", retentionUntil: null }),
  ]
  const { erase, retain } = selectErasable(inputs, NOW)
  assert.deepEqual(erase.map((d) => d.id), ["a"])
  assert.deepEqual(retain.map((d) => d.id), ["b", "c", "d"])
  assert.equal(erase.length + retain.length, inputs.length)
})

test("a retention window shorter than the floor is refused", () => {
  assert.equal(refusal(() => retentionDeadline(NOW, 59)), "RETENTION_TOO_SHORT")
  assert.equal(refusal(() => retentionDeadline(NOW, 0)), "RETENTION_TOO_SHORT")
  assert.equal(refusal(() => retentionDeadline(NOW, -1)), "RETENTION_TOO_SHORT")
})

test("a valid retention window produces a deadline after creation", () => {
  const deadline = retentionDeadline(NOW, 3600)
  assert.equal(deadline.toISOString(), "2026-09-10T13:00:00.000Z")
})

test("an erasure that loses the original digest is refused", () => {
  assert.equal(
    refusal(() =>
      assertErasureRecord(
        { requestSha256: `0x${"a".repeat(64)}`, requestByteLength: 2048 },
        { erasedRequestSha256: `0x${"b".repeat(64)}`, erasedAt: NOW, requestByteLength: 1 },
      ),
    ),
    "DIGEST_NOT_PRESERVED",
  )
})

test("an erasure that does not reduce the payload is refused", () => {
  assert.equal(
    refusal(() =>
      assertErasureRecord(
        { requestSha256: `0x${"a".repeat(64)}`, requestByteLength: 2048 },
        { erasedRequestSha256: `0x${"a".repeat(64)}`, erasedAt: NOW, requestByteLength: 2048 },
      ),
    ),
    "PAYLOAD_NOT_REDUCED",
  )
})

test("an erasure that leaves more than a tombstone is refused", () => {
  assert.equal(
    refusal(() =>
      assertErasureRecord(
        { requestSha256: `0x${"a".repeat(64)}`, requestByteLength: 2048 },
        { erasedRequestSha256: `0x${"a".repeat(64)}`, erasedAt: NOW, requestByteLength: 64 },
      ),
    ),
    "TOMBSTONE_UNEXPECTED",
  )
})

test("an erasure with no recorded time is refused", () => {
  assert.equal(
    refusal(() =>
      assertErasureRecord(
        { requestSha256: `0x${"a".repeat(64)}`, requestByteLength: 2048 },
        { erasedRequestSha256: `0x${"a".repeat(64)}`, erasedAt: null, requestByteLength: 1 },
      ),
    ),
    "ERASURE_NOT_RECORDED",
  )
})

test("a correctly formed erasure is accepted", () => {
  assertErasureRecord(
    { requestSha256: `0x${"a".repeat(64)}`, requestByteLength: 2048 },
    { erasedRequestSha256: `0x${"a".repeat(64)}`, erasedAt: NOW, requestByteLength: 1 },
  )
})
