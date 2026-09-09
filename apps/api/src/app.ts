import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { ZodError } from "zod"
import { Erc8004IdentityError } from "../../../packages/chain/src/erc8004-identity.ts"
import { ServiceQuoteVerificationError } from "../../../packages/contracts/src/service-quote.ts"
import { ServiceRequestPreparationError } from "../../../packages/contracts/src/service-request.ts"
import {
  IdempotencyConflictError,
  TaskDeadlineElapsedError,
  type ServiceRequestRecord,
  type VerifiedQuoteRecord,
} from "../../../packages/db/src/index.ts"
import { OwnedSellerClientError } from "../../../packages/security/src/owned-seller-client.ts"
import { ApiError, invalidRequest, upstreamUnavailable } from "./errors.ts"
import { TaskConflictError, VerifiedQuoteCreationUnavailableError } from "./pg-store.ts"
import { createServiceRequest, createTaskRequest, createVerifiedQuoteRequest, identifier, parseJson } from "./schemas.ts"
import type { ApiConfig, ApiRequest, ApiResponse, ApiStore, StoredTask } from "./types.ts"
import { VerifiedQuoteOrchestrationError } from "./verified-quote-orchestrator.ts"

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

const serviceRequestResponse = (record: ServiceRequestRecord) => ({
  id: record.id,
  buyer: record.buyer,
  endpoint: record.endpoint,
  idempotencyKey: record.idempotencyKey,
  taskId: record.taskId,
  category: record.category,
  requestSchemaVersion: record.requestSchemaVersion,
  transport: record.transport,
  requestByteLength: record.requestBytes.length,
  requestSha256: record.requestSha256,
  requestKeccak256: record.requestKeccak256,
  taskDescription: record.taskDescription,
  taskDescriptionSha256: record.taskDescriptionSha256,
  snapshotId: record.snapshotId,
  taskInputHash: record.taskInputHash,
  inputBinding: record.inputBinding,
  createdAt: record.createdAt.toISOString(),
})

const verifiedQuoteResponse = (record: VerifiedQuoteRecord, now: Date) => {
  const expiresAtMilliseconds = Number(record.expiresAtUnix) * 1_000
  return {
    stage: "VERIFIED_PRE_FUNDING",
    id: record.id,
    serviceRequestId: record.serviceRequestId,
    taskId: record.taskId,
    sellerEndpoint: record.sellerEndpoint,
    providerAgentId: record.providerAgentId,
    identity: {
      chainId: record.sellerIdentityChainId,
      registry: record.sellerRegistry,
      agentId: record.sellerAgentId,
      owner: record.sellerOwner,
      observationId: record.identityObservationId,
      blockNumber: record.identityBlockNumber,
      blockHash: record.identityBlockHash,
      observedAt: record.identityObservedAt.toISOString(),
    },
    quote: record.quote,
    requestHash: record.requestHash,
    responseHash: record.responseHash,
    negotiationHash: record.negotiationHash,
    jobDescriptionSha256: record.jobDescriptionSha256,
    verifierVersion: record.verifierVersion,
    verifiedAt: record.verifiedAt.toISOString(),
    expiresAtUnix: record.expiresAtUnix,
    expired: !Number.isSafeInteger(expiresAtMilliseconds) || expiresAtMilliseconds <= now.getTime(),
    fundingPermitted: false,
  }
}

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
  if (error instanceof IdempotencyConflictError) {
    return new ApiError(409, "CONFLICT", "The idempotency key is bound to different intent.", false)
  }
  if (error instanceof TaskDeadlineElapsedError) {
    return invalidRequest("The task deadline has elapsed; no new service request can be created.")
  }
  if (error instanceof ServiceRequestPreparationError) {
    return invalidRequest("The service request does not match its task and seller contract.")
  }
  if (error instanceof VerifiedQuoteCreationUnavailableError) {
    return new ApiError(503, "UPSTREAM_UNAVAILABLE", "Verified pre-funding quote creation is unavailable.", true, "unfunded")
  }
  if (error instanceof VerifiedQuoteOrchestrationError) {
    if (error.code === "REQUEST_NOT_FOUND") {
      return new ApiError(404, "RESOURCE_NOT_FOUND", "The service request was not found.", false, "unfunded")
    }
    if (error.code === "REQUEST_EXPIRED") {
      return invalidRequest("The service request task deadline has elapsed; no new quote can be created.")
    }
    if (error.code === "SELLER_AUTHORITY_MISMATCH") {
      return new ApiError(400, "AUTHORITY_MISMATCH", "The service request is not bound to a supported owned seller.", false, "unfunded")
    }
    return new ApiError(502, "RESULT_INCOMPLETE", "The seller identity could not be verified.", false, "unfunded")
  }
  if (error instanceof OwnedSellerClientError) {
    if (error.code === "OAUTH_UNAVAILABLE" || error.code === "SELLER_UNAVAILABLE" || error.code === "REQUEST_ABORTED") {
      return new ApiError(503, "UPSTREAM_UNAVAILABLE", "The owned seller did not complete the quote request.", true, "unfunded")
    }
    return new ApiError(502, "RESULT_INCOMPLETE", "The owned seller returned an invalid quote response.", false, "unfunded")
  }
  if (error instanceof Erc8004IdentityError) {
    if (
      error.code === "UPSTREAM_UNAVAILABLE" ||
      error.code === "STALE_BLOCK" ||
      error.code === "ORPHANED_OBSERVATION" ||
      error.code === "RPC_DISAGREEMENT"
    ) {
      return new ApiError(503, "UPSTREAM_UNAVAILABLE", "The BSC testnet identity observation is unavailable.", true, "unfunded")
    }
    return new ApiError(502, "RESULT_INCOMPLETE", "The BSC testnet identity observation did not match the sealed seller.", false, "unfunded")
  }
  if (error instanceof ServiceQuoteVerificationError) {
    return new ApiError(502, "RESULT_INCOMPLETE", "The owned seller quote failed cryptographic verification.", false, "unfunded")
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
      const serviceRequestCreationMatch = request.path.match(/^\/api\/tasks\/([^/]+)\/service-requests$/)
      if (request.method === "POST" && serviceRequestCreationMatch) {
        requireMutationOrigin(request, config)
        requireAuthorization(request, config)
        const taskId = decodeIdentifier(serviceRequestCreationMatch[1] ?? "")
        const body = requireJson(request, config.maxBodyBytes)
        const decoded = parseJson(body)
        if (decoded === undefined) throw invalidRequest("The request body is not valid JSON.")
        const parsed = createServiceRequest.safeParse(decoded)
        if (!parsed.success) throw invalidRequest("The service request does not match knot.service-request/1.")
        if (parsed.data.envelope.task.taskId !== taskId) {
          throw invalidRequest("The service request task does not match the resource path.")
        }
        if (request.headers["idempotency-key"] !== parsed.data.id) {
          throw invalidRequest("Idempotency-Key must equal the immutable service request identifier.")
        }
        const task = await store.getTask(taskId, config.buyerAddress)
        if (!task) throw new ApiError(404, "RESOURCE_NOT_FOUND", "The task was not found.", false)
        const existing = await store.getServiceRequest(parsed.data.id, config.buyerAddress)
        if (!existing && new Date(task.task.deadlineUtc).getTime() <= config.now().getTime()) {
          throw invalidRequest("The task deadline has elapsed; no new service request can be created.")
        }
        const result = await store.createServiceRequest({
          id: parsed.data.id,
          buyer: config.buyerAddress,
          endpoint: parsed.data.endpoint,
          idempotencyKey: parsed.data.id,
          envelope: parsed.data.envelope,
        })
        return encode(result.created ? 201 : 200, serviceRequestResponse(result.record), correlationId, config.allowedOrigin)
      }
      const serviceRequestMatch = request.path.match(/^\/api\/service-requests\/([^/]+)$/)
      if (request.method === "GET" && serviceRequestMatch) {
        requireAuthorization(request, config)
        const id = decodeIdentifier(serviceRequestMatch[1] ?? "")
        const record = await store.getServiceRequest(id, config.buyerAddress)
        if (!record) throw new ApiError(404, "RESOURCE_NOT_FOUND", "The service request was not found.", false)
        return encode(200, serviceRequestResponse(record), correlationId, config.allowedOrigin)
      }
      const verifiedQuoteCreationMatch = request.path.match(/^\/api\/service-requests\/([^/]+)\/verified-quotes$/)
      if (request.method === "POST" && verifiedQuoteCreationMatch) {
        requireMutationOrigin(request, config)
        requireAuthorization(request, config)
        const serviceRequestId = decodeIdentifier(verifiedQuoteCreationMatch[1] ?? "")
        const body = requireJson(request, config.maxBodyBytes)
        const decoded = parseJson(body)
        if (!createVerifiedQuoteRequest.safeParse(decoded).success) {
          throw invalidRequest("The verified quote request body must be an empty JSON object.")
        }
        if (request.headers["idempotency-key"] !== serviceRequestId) {
          throw invalidRequest("Idempotency-Key must equal the immutable service request identifier.")
        }
        const result = await store.createVerifiedQuote(serviceRequestId, config.buyerAddress)
        return encode(
          result.created ? 201 : 200,
          verifiedQuoteResponse(result.record, config.now()),
          correlationId,
          config.allowedOrigin,
        )
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
