import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { inflateRawSync } from "node:zlib"
import {
  COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX,
  MAX_SERVICE_TASK_DESCRIPTION_BYTES,
  MAX_SERVICE_REQUEST_BYTES,
  SERVICE_REQUEST_TRANSPORT_PREFIX,
  ServiceRequestPreparationError,
  prepareServiceRequest,
} from "../../packages/contracts/src/service-request.ts"

const buyer = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930"
const evidenceRoot = "evidence/advantage"

const fixtures = [
  { directory: "healthguard-1185", schemaVersion: "knot.health.request/1", transport: "base64url", binding: "LEGACY_EMBEDDED_TASK" },
  { directory: "rangepilot-1189", schemaVersion: "knot.rangepilot.request/1", transport: "deflate-base64url", binding: "EXACT_REQUEST_BYTES" },
  { directory: "gridquant-1187", schemaVersion: "knot.gridquant.request/2", transport: "deflate-base64url", binding: "EXACT_REQUEST_BYTES" },
  { directory: "yieldscout-1188", schemaVersion: "knot.yield.request/2", transport: "deflate-base64url", binding: "EXACT_REQUEST_BYTES" },
] as const

const fixture = async (entry: (typeof fixtures)[number]) => {
  const requestBytes = await readFile(`${evidenceRoot}/${entry.directory}/input.json`)
  const task = JSON.parse(await readFile(`${evidenceRoot}/${entry.directory}/task.json`, "utf8")) as unknown
  return {
    requestBytes,
    envelope: {
      schemaVersion: "knot.service-request/1",
      task,
      request: {
        mediaType: "application/json",
        schemaVersion: entry.schemaVersion,
        bytesBase64url: requestBytes.toString("base64url"),
      },
      transport: entry.transport,
    },
  }
}

for (const entry of fixtures) {
  test(`prepares exact retained ${entry.directory} seller request bytes`, async () => {
    const value = await fixture(entry)
    const prepared = prepareServiceRequest(value.envelope, buyer)
    assert.equal(prepared.requestByteLength, value.requestBytes.length)
    assert.equal(prepared.requestBytesBase64url, value.requestBytes.toString("base64url"))
    assert.equal(prepared.inputBinding, entry.binding)
    assert.ok(Buffer.byteLength(prepared.taskDescription, "utf8") <= MAX_SERVICE_TASK_DESCRIPTION_BYTES)
    const decoded = prepared.transport === "base64url"
      ? Buffer.from(prepared.taskDescription.slice(SERVICE_REQUEST_TRANSPORT_PREFIX.length), "base64url")
      : inflateRawSync(Buffer.from(prepared.taskDescription.slice(COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX.length), "base64url"))
    assert.deepEqual(decoded, value.requestBytes)
  })
}

test("rejects a TaskSpec-only seller payload before negotiation", async () => {
  const value = await fixture(fixtures[2])
  const taskBytes = Buffer.from(JSON.stringify(value.envelope.task), "utf8")
  const envelope = {
    ...value.envelope,
    request: { ...value.envelope.request, bytesBase64url: taskBytes.toString("base64url") },
  }
  assert.throws(
    () => prepareServiceRequest(envelope, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "SELLER_SCHEMA_MISMATCH",
  )
})

test("rejects an uncompressed request that cannot leave safe room for the signed quote", async () => {
  const value = await fixture(fixtures[1])
  assert.throws(
    () => prepareServiceRequest({ ...value.envelope, transport: "base64url" }, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "REQUEST_TOO_LARGE",
  )
})

test("rejects byte changes that break an exact TaskSpec input hash", async () => {
  const value = await fixture(fixtures[1])
  const changedBytes = Buffer.concat([value.requestBytes, Buffer.from("\n")])
  const envelope = {
    ...value.envelope,
    request: { ...value.envelope.request, bytesBase64url: changedBytes.toString("base64url") },
  }
  assert.throws(
    () => prepareServiceRequest(envelope, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "TASK_BINDING_MISMATCH",
  )
})

test("rejects category bindings and requester authority mismatches", async () => {
  const value = await fixture(fixtures[2])
  const request = JSON.parse(value.requestBytes.toString("utf8")) as { task: { requester: string }; snapshot: { requester: string } }
  request.task.requester = "0x1111111111111111111111111111111111111111"
  request.snapshot.requester = request.task.requester
  const bytes = Buffer.from(JSON.stringify(request), "utf8")
  const task = value.envelope.task as { inputHash: string }
  const envelope = {
    ...value.envelope,
    task: { ...task, inputHash: "0x92962f6a778439713494e2f9bca3096e11d196b5480f8fa80fb4284fe370f090" },
    request: { ...value.envelope.request, bytesBase64url: bytes.toString("base64url") },
  }
  assert.throws(
    () => prepareServiceRequest(envelope, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "TASK_BINDING_MISMATCH",
  )
})

test("rejects compressed HealthGuard v1 and noncanonical request bytes", async () => {
  const value = await fixture(fixtures[0])
  assert.throws(
    () => prepareServiceRequest({ ...value.envelope, transport: "deflate-base64url" }, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "INVALID_ENVELOPE",
  )
  const invalid = {
    ...value.envelope,
    request: { ...value.envelope.request, bytesBase64url: `${value.envelope.request.bytesBase64url}=` },
  }
  assert.throws(
    () => prepareServiceRequest(invalid, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "INVALID_ENVELOPE",
  )
})

test("rejects request bytes above the shared seller limit", async () => {
  const value = await fixture(fixtures[2])
  const bytes = Buffer.alloc(MAX_SERVICE_REQUEST_BYTES + 1, 32)
  const envelope = {
    ...value.envelope,
    request: { ...value.envelope.request, bytesBase64url: bytes.toString("base64url") },
  }
  assert.throws(
    () => prepareServiceRequest(envelope, buyer),
    (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "REQUEST_TOO_LARGE",
  )
})

for (const entry of fixtures) {
  test(`rejects a guaranteed ${entry.directory} capability refusal before negotiation`, async () => {
    const value = await fixture(entry)
    const request = JSON.parse(value.requestBytes.toString("utf8")) as Record<string, unknown>
    const task = structuredClone(value.envelope.task) as Record<string, unknown>
    if (entry.directory === "healthguard-1185") {
      const requestTask = request.task as Record<string, unknown>
      requestTask.capability = "monitoring"
      task.capability = "monitoring"
    } else if (entry.directory === "rangepilot-1189") {
      const requestTask = request.task as { capability: string; constraints: { executionMode: string } }
      requestTask.capability = "monitoring"
      requestTask.constraints.executionMode = "reviewed"
      task.capability = "monitoring"
      ;(task.constraints as { executionMode: string }).executionMode = "reviewed"
    } else if (entry.directory === "gridquant-1187") {
      const requestTask = request.task as { capability: string; parameters: { executionMode: string } }
      requestTask.capability = "monitoring"
      requestTask.parameters.executionMode = "conditional-swaps"
      task.capability = "monitoring"
      ;(task.constraints as { mode: string }).mode = "execute"
    } else {
      request.capability = "monitoring"
      task.capability = "monitoring"
    }
    const requestBytes = Buffer.from(JSON.stringify(request), "utf8")
    const inputHash = entry.directory === "healthguard-1185"
      ? task.inputHash
      : (await import("viem")).keccak256(requestBytes)
    request.inputHash = inputHash
    task.inputHash = inputHash
    const envelope = {
      ...value.envelope,
      task,
      request: { ...value.envelope.request, bytesBase64url: requestBytes.toString("base64url") },
    }
    assert.throws(
      () => prepareServiceRequest(envelope, buyer),
      (error: unknown) => error instanceof ServiceRequestPreparationError && error.code === "SELLER_CAPABILITY_MISMATCH",
    )
  })
}
