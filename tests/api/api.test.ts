import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createApiHandler } from "../../apps/api/src/app.ts"
import type {
  AccessScope,
  ApiConfig,
  ApiRequest,
  ApiStore,
  StoredJob,
  StoredTask,
  TaskCreation,
} from "../../apps/api/src/types.ts"
import type { TaskSpec } from "../../packages/contracts/src/task.ts"

const buyer = "0x1111111111111111111111111111111111111111"
const token = "test-token-that-is-at-least-32-characters"
const origin = "https://knot.example"
const digest = `0x${"a".repeat(64)}`
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
