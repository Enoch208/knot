import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { ZodError } from "zod"
import { ApiError, invalidRequest, upstreamUnavailable } from "./errors.ts"
import { TaskConflictError } from "./pg-store.ts"
import { createTaskRequest, identifier, parseJson } from "./schemas.ts"
import type { ApiConfig, ApiRequest, ApiResponse, ApiStore, StoredTask } from "./types.ts"

const correlationPattern = /^[A-Za-z0-9._:-]{1,128}$/

const authorized = (header: string | undefined, expected: string): boolean => {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const left = createHash("sha256").update(supplied).digest()
  const right = createHash("sha256").update(expected).digest()
  return supplied.length > 0 && timingSafeEqual(left, right)
}

const encode = (status: number, value: unknown, correlationId: string, origin: string): ApiResponse => ({
  status,
  headers: {
    "access-control-allow-origin": origin,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "vary": "origin",
    "x-correlation-id": correlationId,
  },
  body: JSON.stringify(value),
})

const taskResponse = (stored: StoredTask) => ({
    buyer: stored.buyer,
    task: stored.task,
    accessScope: stored.accessScope,
    createdAt: stored.createdAt.toISOString(),
})

const decodeIdentifier = (encoded: string): string => {
  try {
    const decoded = decodeURIComponent(encoded)
    if (!identifier.safeParse(decoded).success) throw invalidRequest("Invalid resource identifier.")
    return decoded
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw invalidRequest("Invalid resource identifier.")
  }
}

const requireAuthorization = (request: ApiRequest, config: ApiConfig): void => {
  if (!authorized(request.headers.authorization, config.authToken)) {
    throw new ApiError(401, "AUTHORITY_MISMATCH", "Valid API authorization is required.", false)
  }
}

const requireMutationOrigin = (request: ApiRequest, config: ApiConfig): void => {
  if (request.headers.origin !== config.allowedOrigin) {
    throw new ApiError(403, "AUTHORITY_MISMATCH", "The request origin is not allowed.", false)
  }
}

const requireJson = (request: ApiRequest, maxBodyBytes: number): string => {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw invalidRequest("Content-Type must be application/json.")
  }
  if (request.body === null) {
    throw invalidRequest("A JSON request body is required.")
  }
  if (Buffer.byteLength(request.body, "utf8") > maxBodyBytes) {
    throw new ApiError(413, "INVALID_REQUEST", "The request body exceeds the allowed size.", false)
  }
  return request.body
}

const asFailure = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error
  if (error instanceof TaskConflictError) {
    return new ApiError(409, "CONFLICT", "The task identifier is bound to different intent.", false)
  }
  if (error instanceof ZodError) {
    return new ApiError(500, "RESULT_INCOMPLETE", "Stored data failed integrity validation.", false)
  }
  return upstreamUnavailable()
}

export const createApiHandler = (store: ApiStore, config: ApiConfig) => {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    const receivedCorrelation = request.headers["x-correlation-id"]
    const correlationId =
      receivedCorrelation && correlationPattern.test(receivedCorrelation)
        ? receivedCorrelation
        : randomUUID()
    try {
      if (request.method === "OPTIONS") {
        requireMutationOrigin(request, config)
        return {
          status: 204,
          headers: {
            "access-control-allow-headers": "authorization, content-type, idempotency-key, x-correlation-id",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-origin": config.allowedOrigin,
            "cache-control": "no-store",
            "vary": "origin",
            "x-correlation-id": correlationId,
          },
          body: "",
        }
      }
      if (request.method === "GET" && (request.path === "/health" || request.path === "/api/status")) {
        await store.status()
        return encode(200, {
          service: "knot-api",
          status: "AVAILABLE",
          checkedAt: config.now().toISOString(),
          dependencies: { database: "AVAILABLE" },
        }, correlationId, config.allowedOrigin)
      }
      if (request.method === "POST" && request.path === "/api/tasks") {
        requireMutationOrigin(request, config)
        requireAuthorization(request, config)
        const body = requireJson(request, config.maxBodyBytes)
        const decoded = parseJson(body)
        if (decoded === undefined) throw invalidRequest("The request body is not valid JSON.")
        const parsed = createTaskRequest.safeParse(decoded)
        if (!parsed.success) throw invalidRequest("The task request does not match knot.task/1.")
        if (!identifier.safeParse(parsed.data.task.taskId).success) {
          throw invalidRequest("The task identifier contains unsupported characters.")
        }
        if (new Date(parsed.data.task.deadlineUtc).getTime() <= config.now().getTime()) {
          throw invalidRequest("The task deadline must be in the future.")
        }
        if (request.headers["idempotency-key"] !== parsed.data.task.taskId) {
          throw invalidRequest("Idempotency-Key must equal the immutable task identifier.")
        }
        const result = await store.createTask(
          config.buyerAddress,
          parsed.data.task,
          parsed.data.accessScope,
        )
        return encode(result.created ? 201 : 200, taskResponse(result.task), correlationId, config.allowedOrigin)
      }
      const taskMatch = request.path.match(/^\/api\/tasks\/([^/]+)$/)
      if (request.method === "GET" && taskMatch) {
        requireAuthorization(request, config)
        const taskId = decodeIdentifier(taskMatch[1] ?? "")
        const task = await store.getTask(taskId, config.buyerAddress)
        if (!task) throw new ApiError(404, "RESOURCE_NOT_FOUND", "The task was not found.", false)
        return encode(200, taskResponse(task), correlationId, config.allowedOrigin)
      }
      const jobMatch = request.path.match(/^\/api\/jobs\/([^/]+)$/)
      if (request.method === "GET" && jobMatch) {
        requireAuthorization(request, config)
        const jobId = decodeIdentifier(jobMatch[1] ?? "")
        const job = await store.getJob(jobId, config.buyerAddress)
        if (!job) throw new ApiError(404, "RESOURCE_NOT_FOUND", "The job was not found.", false)
        return encode(200, {
          ...job,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          artifacts: job.artifacts.map((artifact) => ({
            ...artifact,
            retentionUntil: artifact.retentionUntil.toISOString(),
            createdAt: artifact.createdAt.toISOString(),
          })),
          events: job.events.map((event) => ({
            ...event,
            createdAt: event.createdAt.toISOString(),
          })),
          permittedNextActions: [],
        }, correlationId, config.allowedOrigin)
      }
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "The requested API resource was not found.", false)
    } catch (error) {
      const failure = asFailure(error)
      return encode(failure.status, {
        code: failure.code,
        explanation: failure.message,
        retryable: failure.retryable,
        correlationId,
        financialState: failure.financialState,
      }, correlationId, config.allowedOrigin)
    }
  }
}
