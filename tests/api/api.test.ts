import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { createApiHandler } from "../../apps/api/src/app.ts"
import { VerifiedQuoteOrchestrationError } from "../../apps/api/src/verified-quote-orchestrator.ts"
import { Erc8004IdentityError } from "../../packages/chain/src/erc8004-identity.ts"
import type {
  AccessScope,
  ApiConfig,
  ApiRequest,
  ApiStore,
  StoredJob,
  StoredTask,
  TaskCreation,
} from "../../apps/api/src/types.ts"
import { prepareServiceRequest, type ServiceRequestEnvelope } from "../../packages/contracts/src/service-request.ts"
import { taskSpec, type TaskSpec } from "../../packages/contracts/src/task.ts"
import {
  TaskDeadlineElapsedError,
  type ServiceRequestCreation,
  type ServiceRequestRecord,
  type VerifiedQuoteCreation,
  type VerifiedQuoteRecord,
} from "../../packages/db/src/index.ts"

const buyer = "0x1111111111111111111111111111111111111111"
const token = "test-token-that-is-at-least-32-characters"
const origin = "https://knot.example"
const digest = `0x${"a".repeat(64)}`
const retainedRequestBytes = readFileSync("evidence/advantage/rangepilot-1189/input.json")
const retainedTask = taskSpec.parse(JSON.parse(readFileSync("evidence/advantage/rangepilot-1189/task.json", "utf8")) as unknown)
const retainedEnvelope = (): ServiceRequestEnvelope => ({
  schemaVersion: "knot.service-request/1",
  task: retainedTask,
  request: {
    mediaType: "application/json",
    schemaVersion: "knot.rangepilot.request/1",
    bytesBase64url: retainedRequestBytes.toString("base64url"),
  },
  transport: "deflate-base64url",
})

const verifiedQuoteRecord = (): VerifiedQuoteRecord => ({
  id: "request_range_quote",
  serviceRequestId: "request_range_quote",
  taskId: retainedTask.taskId,
  sellerEndpoint: "https://knot-range.truematchx.com/",
  providerAgentId: "owned_rangepilot_2297",
  sellerIdentityChainId: 97,
  sellerRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  sellerAgentId: "2297",
  sellerOwner: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  identityObservationId: "erc8004_2297_130090000_1212121212121212",
  identityBlockNumber: "130090000",
  identityBlockHash: `0x${"12".repeat(32)}`,
  identityObservedAt: new Date("2026-09-09T11:59:30.000Z"),
  quote: { accepted: true } as unknown as VerifiedQuoteRecord["quote"],
  requestHash: `0x${"23".repeat(32)}`,
  responseHash: `0x${"34".repeat(32)}`,
  negotiationHash: `0x${"45".repeat(32)}`,
  jobDescriptionSha256: `0x${"56".repeat(32)}`,
  verifierVersion: "knot.owned-seller-quote/2",
  verifiedAt: new Date("2026-09-09T12:00:00.000Z"),
  expiresAtUnix: "1788956100",
  fundingPermitted: false,
} as unknown as VerifiedQuoteRecord)
type HealthTask = Extract<TaskSpec, { category: "health" }>

const healthTask = (overrides: Partial<HealthTask> = {}): HealthTask => ({
  schemaVersion: "knot.task/1",
  taskId: "task_health_1",
  category: "health",
  capability: "analysis",
  identityChainId: 97,
  dataChainId: 56,
  paymentChainId: 97,
  executionChainId: null,
  target: {
    borrower: buyer,
    comptroller: "0xfd36e2c2a6789db23113685031d7f16329158384",
    poolFamily: "venus-core",
  },
  constraints: {
    safetyThresholdRatio: 1.5,
    actionThresholdRatio: 1.2,
    repaymentAsset: "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565",
    maxRepaymentUnits: "1000000000000000000",
    gasBudgetWei: "5000000000000000",
    pollIntervalSeconds: 300,
    mode: "notify",
  },
  serviceFeeLimit: {
    chainId: 97,
    token: "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565",
    units: "100000000000000000",
    decimals: 18,
  },
  managedPrincipal: [],
  executionSpendLimits: [],
  deadlineUtc: "2030-01-01T00:00:00.000Z",
  inputHash: digest,
  snapshotId: null,
  ...overrides,
})

class MemoryStore implements ApiStore {
  readonly tasks = new Map<string, StoredTask>()
  readonly jobs = new Map<string, StoredJob>()
  readonly serviceRequests = new Map<string, ServiceRequestRecord>()
  verifiedQuoteCalls = 0
  available = true

  async status(): Promise<void> {
    if (!this.available) throw new Error("postgresql://secret@internal.example/knot")
  }

  async createTask(owner: string, task: TaskSpec, accessScope: AccessScope): Promise<TaskCreation> {
    const existing = this.tasks.get(task.taskId)
    if (existing) return { task: existing, created: false }
    const stored = { buyer: owner, task, accessScope, createdAt: new Date("2026-09-09T10:00:00Z") }
    this.tasks.set(task.taskId, stored)
    return { task: stored, created: true }
  }

  async getTask(taskId: string, owner: string): Promise<StoredTask | null> {
    const task = this.tasks.get(taskId)
    return task?.buyer === owner ? task : null
  }

  async createServiceRequest(input: {
    id: string
    buyer: string
    endpoint: string
    idempotencyKey: string
    envelope: ServiceRequestEnvelope
  }): Promise<ServiceRequestCreation> {
    const existing = this.serviceRequests.get(input.id)
    if (existing) return { record: existing, created: false }
    const prepared = prepareServiceRequest(input.envelope, input.buyer)
    const record: ServiceRequestRecord = {
      id: input.id,
      buyer: prepared.buyer,
      endpoint: input.endpoint,
      idempotencyKey: input.idempotencyKey,
      taskId: prepared.taskId,
      task: prepared.task,
      category: prepared.category,
      requestSchemaVersion: prepared.requestSchemaVersion,
      transport: prepared.transport,
      requestBytes: Buffer.from(prepared.requestBytesBase64url, "base64url"),
      requestSha256: prepared.requestSha256,
      requestKeccak256: prepared.requestKeccak256,
      taskDescription: prepared.taskDescription,
      taskDescriptionSha256: prepared.taskDescriptionSha256,
      snapshotId: prepared.snapshotId,
      taskInputHash: prepared.taskInputHash as `0x${string}`,
      inputBinding: prepared.inputBinding,
      createdAt: new Date("2026-09-09T10:00:00Z"),
    }
    this.serviceRequests.set(input.id, record)
    return { record, created: true }
  }

  async getServiceRequest(id: string, owner: string): Promise<ServiceRequestRecord | null> {
    const record = this.serviceRequests.get(id)
    return record?.buyer === owner ? record : null
  }

  async createVerifiedQuote(): Promise<VerifiedQuoteCreation> {
    this.verifiedQuoteCalls += 1
    return { record: verifiedQuoteRecord(), created: true }
  }

  async getJob(jobId: string, owner: string): Promise<StoredJob | null> {
    const job = this.jobs.get(jobId)
    return job?.buyer === owner ? job : null
  }
}

const config: ApiConfig = {
  authToken: token,
  buyerAddress: buyer,
  allowedOrigin: origin,
  maxBodyBytes: 65_536,
  now: () => new Date("2026-09-09T12:00:00Z"),
}

const request = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  method: "GET",
  path: "/health",
  headers: {},
  body: null,
  ...overrides,
})

const authenticatedHeaders = (taskId?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  origin,
  ...(taskId ? { "idempotency-key": taskId } : {}),
})

describe("KNOT HTTP API", () => {
  it("reports database-backed status with a propagated safe correlation identifier", async () => {
    const store = new MemoryStore()
    const response = await createApiHandler(store, config)(request({
      headers: { "x-correlation-id": "request-123" },
    }))
    assert.equal(response.status, 200)
    assert.equal(response.headers["x-correlation-id"], "request-123")
    assert.deepEqual(JSON.parse(response.body), {
      service: "knot-api",
      status: "AVAILABLE",
      checkedAt: "2026-09-09T12:00:00.000Z",
      dependencies: { database: "AVAILABLE" },
    })
  })

  it("fails status closed without exposing a database error or credential", async () => {
    const store = new MemoryStore()
    store.available = false
    const response = await createApiHandler(store, config)(request())
    assert.equal(response.status, 503)
    assert.equal(JSON.parse(response.body).code, "UPSTREAM_UNAVAILABLE")
    assert.doesNotMatch(response.body, /postgresql|secret|internal\.example/)
  })

  it("creates and idempotently reads a strict private task", async () => {
    const store = new MemoryStore()
    const task = healthTask()
    const handle = createApiHandler(store, config)
    const creation = request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders(task.taskId),
      body: JSON.stringify({ task, accessScope: { visibility: "PRIVATE" } }),
    })
    const first = await handle(creation)
    const second = await handle(creation)
    const read = await handle(request({
      path: `/api/tasks/${task.taskId}`,
      headers: authenticatedHeaders(),
    }))
    assert.equal(first.status, 201)
    assert.equal(second.status, 200)
    assert.equal(read.status, 200)
    assert.equal(JSON.parse(read.body).task.taskId, task.taskId)
  })

  it("persists a byte-exact seller request before negotiation and reads it privately", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, config)
    const taskCreation = await handle(request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders(retainedTask.taskId),
      body: JSON.stringify({ task: retainedTask, accessScope: { visibility: "PRIVATE" } }),
    }))
    assert.equal(taskCreation.status, 201)
    const id = "request_range_1"
    const creation = request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders(id),
      body: JSON.stringify({ id, endpoint: "https://knot-range.truematchx.com/", envelope: retainedEnvelope() }),
    })
    const first = await handle(creation)
    const second = await handle(creation)
    const read = await handle(request({
      path: `/api/service-requests/${id}`,
      headers: authenticatedHeaders(),
    }))
    assert.equal(first.status, 201)
    assert.equal(second.status, 200)
    assert.equal(read.status, 200)
    const body = JSON.parse(read.body) as { inputBinding: string; requestByteLength: number; taskDescription: string }
    assert.equal(body.inputBinding, "EXACT_REQUEST_BYTES")
    assert.equal(body.requestByteLength, retainedRequestBytes.length)
    assert.match(body.taskDescription, /^knot-json-deflate-base64url\/1:[A-Za-z0-9_-]+$/)
  })

  it("creates only a private verified pre-funding quote from an empty trigger", async () => {
    const store = new MemoryStore()
    const id = "request_range_quote"
    const response = await createApiHandler(store, config)(request({
      method: "POST",
      path: `/api/service-requests/${id}/verified-quotes`,
      headers: authenticatedHeaders(id),
      body: "{}",
    }))
    assert.equal(response.status, 201)
    assert.equal(store.verifiedQuoteCalls, 1)
    const body = JSON.parse(response.body) as Record<string, unknown>
    assert.equal(body.stage, "VERIFIED_PRE_FUNDING")
    assert.equal(body.serviceRequestId, id)
    assert.equal(body.fundingPermitted, false)
    assert.equal(body.expired, false)
    assert.equal("jobId" in body, false)
    assert.equal("transactionHash" in body, false)
  })

  it("rejects quote-trigger authority and body changes before orchestration", async () => {
    const id = "request_range_quote"
    const cases: ApiRequest[] = [
      request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: { ...authenticatedHeaders(id), authorization: undefined },
        body: "{}",
      }),
      request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: { ...authenticatedHeaders(id), origin: "https://attacker.example" },
        body: "{}",
      }),
      request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: authenticatedHeaders("different"),
        body: "{}",
      }),
      request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: authenticatedHeaders(id),
        body: JSON.stringify({ endpoint: "https://attacker.example", quote: {} }),
      }),
    ]
    for (const value of cases) {
      const store = new MemoryStore()
      const response = await createApiHandler(store, config)(value)
      assert.ok(response.status === 400 || response.status === 401 || response.status === 403)
      assert.equal(store.verifiedQuoteCalls, 0)
    }
  })

  it("reports reorg and dual-RPC disagreement as retryable unfunded upstream failures", async () => {
    for (const code of ["UPSTREAM_UNAVAILABLE", "STALE_BLOCK", "ORPHANED_OBSERVATION", "RPC_DISAGREEMENT"] as const) {
      const store = new MemoryStore()
      store.createVerifiedQuote = async () => {
        throw new Erc8004IdentityError(code, `sensitive ${code} details`)
      }
      const id = "request_range_quote"
      const response = await createApiHandler(store, config)(request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: authenticatedHeaders(id),
        body: "{}",
      }))
      const body = JSON.parse(response.body) as Record<string, unknown>
      assert.equal(response.status, 503)
      assert.equal(body.code, "UPSTREAM_UNAVAILABLE")
      assert.equal(body.retryable, true)
      assert.equal(body.financialState, "unfunded")
      assert.equal(response.body.includes("sensitive"), false)
    }
  })

  it("reports sealed identity and deployment mismatches as non-retryable unfunded failures", async () => {
    const failures = [
      ...(["CONFIGURATION_MISMATCH", "DEPLOYMENT_MISMATCH", "IDENTITY_MISMATCH"] as const).map((code) =>
        new Erc8004IdentityError(code, `sensitive ${code} details`)),
      new VerifiedQuoteOrchestrationError("IDENTITY_MISMATCH", "sensitive sealed-owner details"),
    ]
    for (const failure of failures) {
      const store = new MemoryStore()
      store.createVerifiedQuote = async () => {
        throw failure
      }
      const id = "request_range_quote"
      const response = await createApiHandler(store, config)(request({
        method: "POST",
        path: `/api/service-requests/${id}/verified-quotes`,
        headers: authenticatedHeaders(id),
        body: "{}",
      }))
      const body = JSON.parse(response.body) as Record<string, unknown>
      assert.equal(response.status, 502)
      assert.equal(body.code, "RESULT_INCOMPLETE")
      assert.equal(body.retryable, false)
      assert.equal(body.financialState, "unfunded")
      assert.equal(response.body.includes("sensitive"), false)
    }
  })

  it("refuses uncompressed transport that cannot leave safe room for the signed quote", async () => {
    const store = new MemoryStore()
    const id = "request_compressed"
    store.tasks.set(retainedTask.taskId, {
      buyer,
      task: retainedTask,
      accessScope: { visibility: "PRIVATE" },
      createdAt: new Date("2026-09-09T10:00:00Z"),
    })
    const response = await createApiHandler(store, config)(request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders(id),
      body: JSON.stringify({
        id,
        endpoint: "https://knot-range.truematchx.com/",
        envelope: { ...retainedEnvelope(), transport: "base64url" },
      }),
    }))
    assert.equal(response.status, 400)
    assert.equal(store.serviceRequests.size, 0)
  })

  it("rejects service endpoints outside the hardened outbound address policy", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, config)
    await handle(request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders(retainedTask.taskId),
      body: JSON.stringify({ task: retainedTask, accessScope: { visibility: "PRIVATE" } }),
    }))
    const unsafeEndpoints = [
      "https://localhost/",
      "https://seller.internal/",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://knot-range.truematchx.com:444/",
      "https://knot-range.truematchx.com/#fragment",
    ]
    for (const [index, endpoint] of unsafeEndpoints.entries()) {
      const id = `request_unsafe_${index}`
      const response = await handle(request({
        method: "POST",
        path: `/api/tasks/${retainedTask.taskId}/service-requests`,
        headers: authenticatedHeaders(id),
        body: JSON.stringify({ id, endpoint, envelope: retainedEnvelope() }),
      }))
      assert.equal(response.status, 400, endpoint)
      assert.equal(JSON.parse(response.body).code, "INVALID_REQUEST")
    }
    assert.equal(store.serviceRequests.size, 0)
  })

  it("refuses new service requests after deadline while preserving exact retries and reads", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, config)
    await handle(request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders(retainedTask.taskId),
      body: JSON.stringify({ task: retainedTask, accessScope: { visibility: "PRIVATE" } }),
    }))
    const id = "request_before_deadline"
    const creation = request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders(id),
      body: JSON.stringify({ id, endpoint: "https://knot-range.truematchx.com/", envelope: retainedEnvelope() }),
    })
    assert.equal((await handle(creation)).status, 201)

    const afterDeadline = createApiHandler(store, {
      ...config,
      now: () => new Date("2026-09-09T12:04:00Z"),
    })
    const retry = await afterDeadline(creation)
    const read = await afterDeadline(request({
      path: `/api/service-requests/${id}`,
      headers: authenticatedHeaders(),
    }))
    const newId = "request_after_deadline"
    const refused = await afterDeadline(request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders(newId),
      body: JSON.stringify({ id: newId, endpoint: "https://knot-range.truematchx.com/", envelope: retainedEnvelope() }),
    }))
    assert.equal(retry.status, 200)
    assert.equal(read.status, 200)
    assert.equal(refused.status, 400)
    assert.match(JSON.parse(refused.body).explanation, /deadline has elapsed/)
    assert.equal(store.serviceRequests.size, 1)
  })

  it("fails closed when the repository observes the deadline crossing after the API read", async () => {
    const store = new MemoryStore()
    store.tasks.set(retainedTask.taskId, {
      buyer,
      task: retainedTask,
      accessScope: { visibility: "PRIVATE" },
      createdAt: new Date("2026-09-09T10:00:00Z"),
    })
    store.createServiceRequest = async () => {
      throw new TaskDeadlineElapsedError()
    }
    const id = "request_deadline_race"
    const response = await createApiHandler(store, config)(request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders(id),
      body: JSON.stringify({ id, endpoint: "https://knot-range.truematchx.com/", envelope: retainedEnvelope() }),
    }))
    assert.equal(response.status, 400)
    assert.match(JSON.parse(response.body).explanation, /deadline has elapsed/)
  })

  it("refuses a TaskSpec-only seller request before negotiation", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, config)
    await handle(request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders(retainedTask.taskId),
      body: JSON.stringify({ task: retainedTask, accessScope: { visibility: "PRIVATE" } }),
    }))
    const envelope = retainedEnvelope()
    envelope.request.bytesBase64url = Buffer.from(JSON.stringify(retainedTask), "utf8").toString("base64url")
    const response = await handle(request({
      method: "POST",
      path: `/api/tasks/${retainedTask.taskId}/service-requests`,
      headers: authenticatedHeaders("request_invalid_1"),
      body: JSON.stringify({ id: "request_invalid_1", endpoint: "https://knot-range.truematchx.com/", envelope }),
    }))
    assert.equal(response.status, 400)
    assert.equal((JSON.parse(response.body) as { code: string }).code, "INVALID_REQUEST")
    assert.equal(store.serviceRequests.size, 0)
  })

  it("refuses mutations from another origin or without authorization", async () => {
    const store = new MemoryStore()
    const task = healthTask()
    const body = JSON.stringify({ task, accessScope: { visibility: "PRIVATE" } })
    const wrongOrigin = await createApiHandler(store, config)(request({
      method: "POST",
      path: "/api/tasks",
      headers: { ...authenticatedHeaders(task.taskId), origin: "https://evil.example" },
      body,
    }))
    const missingAuth = await createApiHandler(store, config)(request({
      method: "POST",
      path: "/api/tasks",
      headers: { ...authenticatedHeaders(task.taskId), authorization: undefined },
      body,
    }))
    assert.equal(wrongOrigin.status, 403)
    assert.equal(missingAuth.status, 401)
    assert.equal(store.tasks.size, 0)
  })

  it("rejects an oversized mutation before decoding its body", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, { ...config, maxBodyBytes: 32 })
    const response = await handle(request({
      method: "POST",
      path: "/api/tasks",
      headers: authenticatedHeaders("task_health_1"),
      body: JSON.stringify({ task: healthTask(), accessScope: { visibility: "PRIVATE" } }),
    }))
    assert.equal(response.status, 413)
    assert.equal(JSON.parse(response.body).code, "INVALID_REQUEST")
    assert.equal(store.tasks.size, 0)
  })

  it("rejects unknown write fields, expired tasks, and unbound idempotency keys", async () => {
    const store = new MemoryStore()
    const handle = createApiHandler(store, config)
    const task = healthTask()
    const cases = [
      {
        headers: authenticatedHeaders(task.taskId),
        value: { task, accessScope: { visibility: "PRIVATE" }, authority: "execution" },
      },
      {
        headers: authenticatedHeaders(task.taskId),
        value: { task: healthTask({ deadlineUtc: "2026-09-09T11:00:00.000Z" }), accessScope: { visibility: "PRIVATE" } },
      },
      {
        headers: authenticatedHeaders("another-task"),
        value: { task, accessScope: { visibility: "PRIVATE" } },
      },
    ]
    for (const entry of cases) {
      const response = await handle(request({
        method: "POST",
        path: "/api/tasks",
        headers: entry.headers,
        body: JSON.stringify(entry.value),
      }))
      assert.equal(response.status, 400)
      assert.equal(JSON.parse(response.body).code, "INVALID_REQUEST")
    }
    assert.equal(store.tasks.size, 0)
  })

  it("returns separate work and financial job state without inventing an action", async () => {
    const store = new MemoryStore()
    store.jobs.set("job-1", {
      id: "job-1",
      buyer,
      taskId: "task-1",
      quoteId: "quote-1",
      chainId: 97,
      commerce: "0x2222222222222222222222222222222222222222",
      chainJobId: "91",
      workState: "OUTPUT_CHECKED",
      financialState: "ESCROWED",
      protocolState: { observed: true },
      version: 7,
      createdAt: new Date("2026-09-09T08:00:00Z"),
      updatedAt: new Date("2026-09-09T09:00:00Z"),
      artifacts: [],
      events: [{
        id: "event-1",
        sequence: 1,
        eventType: "job.created",
        payload: { workState: "DRAFT" },
        createdAt: new Date("2026-09-09T08:00:00Z"),
      }],
    })
    const response = await createApiHandler(store, config)(request({
      path: "/api/jobs/job-1",
      headers: authenticatedHeaders(),
    }))
    const body = JSON.parse(response.body)
    assert.equal(response.status, 200)
    assert.equal(body.workState, "OUTPUT_CHECKED")
    assert.equal(body.financialState, "ESCROWED")
    assert.equal(body.events[0].sequence, 1)
    assert.deepEqual(body.permittedNextActions, [])
  })

  it("does not reveal whether another buyer owns a private resource", async () => {
    const store = new MemoryStore()
    store.tasks.set("private-task", {
      buyer: "0x2222222222222222222222222222222222222222",
      task: healthTask({ taskId: "private-task" }),
      accessScope: { visibility: "PRIVATE" },
      createdAt: new Date("2026-09-09T10:00:00Z"),
    })
    const response = await createApiHandler(store, config)(request({
      path: "/api/tasks/private-task",
      headers: authenticatedHeaders(),
    }))
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(response.body).code, "RESOURCE_NOT_FOUND")
  })
})
