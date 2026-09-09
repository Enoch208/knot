import { createHash } from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { MAX_DESCRIPTION_BYTES as MAX_ERC8183_DESCRIPTION_BYTES } from "@bnbagent/sdk/erc8183"
import { keccak256 } from "viem"
import { z } from "zod"
import { gridQuantEvaluationInput } from "../../advantage/src/gridquant-schemas.ts"
import { healthGuardEvaluationInput } from "../../advantage/src/healthguard.ts"
import { rangePilotEvaluationInput } from "../../advantage/src/rangepilot-schemas.ts"
import { yieldScoutEvaluationInput } from "../../advantage/src/yieldscout-schemas.ts"
import { address } from "./primitives.ts"
import { taskSpec, type TaskSpec } from "./task.ts"

export const MAX_SERVICE_REQUEST_BYTES = 65_536
export const MAX_ENCODED_SERVICE_REQUEST_CHARS = Math.ceil(MAX_SERVICE_REQUEST_BYTES / 3) * 4
export const SERVICE_REQUEST_QUOTE_RESERVE_BYTES = 896
export const MAX_SERVICE_TASK_DESCRIPTION_BYTES =
  MAX_ERC8183_DESCRIPTION_BYTES - SERVICE_REQUEST_QUOTE_RESERVE_BYTES
export const SERVICE_REQUEST_TRANSPORT_PREFIX = "knot-json-base64url/1:"
export const COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX = "knot-json-deflate-base64url/1:"

const schemaVersions = {
  health: "knot.health.request/1",
  rebalancing: "knot.rangepilot.request/1",
  grid: "knot.gridquant.request/2",
  yield: "knot.yield.request/2",
} as const

const requestBytesBase64url = z
  .string()
  .min(1)
  .max(MAX_ENCODED_SERVICE_REQUEST_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value.length % 4 !== 1 && Buffer.from(value, "base64url").toString("base64url") === value)

export const serviceRequestEnvelope = z
  .object({
    schemaVersion: z.literal("knot.service-request/1"),
    task: taskSpec,
    request: z
      .object({
        mediaType: z.literal("application/json"),
        schemaVersion: z.enum([
          "knot.health.request/1",
          "knot.rangepilot.request/1",
          "knot.gridquant.request/2",
          "knot.yield.request/2",
        ]),
        bytesBase64url: requestBytesBase64url,
      })
      .strict(),
    transport: z.enum(["base64url", "deflate-base64url"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.task.category === "security") {
      context.addIssue({ code: "custom", path: ["task", "category"], message: "security seller requests are not supported" })
      return
    }
    if (value.request.schemaVersion !== schemaVersions[value.task.category]) {
      context.addIssue({ code: "custom", path: ["request", "schemaVersion"], message: "request schema does not match the task category" })
    }
    if (value.task.category === "health" && value.transport === "deflate-base64url") {
      context.addIssue({ code: "custom", path: ["transport"], message: "HealthGuard v1 does not support compressed transport" })
    }
  })

export type ServiceRequestEnvelope = z.infer<typeof serviceRequestEnvelope>
export type ServiceRequestInputBinding = "EXACT_REQUEST_BYTES" | "LEGACY_EMBEDDED_TASK"

export interface PrepareServiceRequestOptions {
  enforceTaskDescriptionLimit?: boolean
}

export interface PreparedServiceRequest {
  schemaVersion: "knot.prepared-service-request/1"
  buyer: `0x${string}`
  task: TaskSpec
  taskId: string
  category: Exclude<TaskSpec["category"], "security">
  requestSchemaVersion: ServiceRequestEnvelope["request"]["schemaVersion"]
  transport: ServiceRequestEnvelope["transport"]
  requestBytesBase64url: string
  requestByteLength: number
  requestSha256: `0x${string}`
  requestKeccak256: `0x${string}`
  taskInputHash: string
  taskDescription: string
  taskDescriptionSha256: `0x${string}`
  snapshotId: string
  inputBinding: ServiceRequestInputBinding
}

export type ServiceRequestPreparationErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_REQUEST_BYTES"
  | "REQUEST_TOO_LARGE"
  | "SELLER_SCHEMA_MISMATCH"
  | "SELLER_CAPABILITY_MISMATCH"
  | "TASK_BINDING_MISMATCH"

export class ServiceRequestPreparationError extends Error {
  readonly code: ServiceRequestPreparationErrorCode

  constructor(code: ServiceRequestPreparationErrorCode, message: string) {
    super(message)
    this.name = "ServiceRequestPreparationError"
    this.code = code
  }
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("value is not JSON serializable")
  return encoded
}

const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)

const failBinding = (message: string): never => {
  throw new ServiceRequestPreparationError("TASK_BINDING_MISMATCH", message)
}

const failCapability = (message: string): never => {
  throw new ServiceRequestPreparationError("SELLER_CAPABILITY_MISMATCH", message)
}

const requireEqual = (left: unknown, right: unknown, message: string): void => {
  if (!equal(left, right)) failBinding(message)
}

const requireBuyer = (requester: string, buyer: string): void => {
  if (requester !== buyer) failBinding("seller request authority does not match the buyer")
}

const sha256 = (bytes: Uint8Array): `0x${string}` =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`

export const decodeServiceRequestTaskDescription = (
  taskDescription: string,
  transport: ServiceRequestEnvelope["transport"],
): Buffer => {
  const prefix = transport === "base64url"
    ? SERVICE_REQUEST_TRANSPORT_PREFIX
    : COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX
  if (!taskDescription.startsWith(prefix)) {
    throw new ServiceRequestPreparationError("INVALID_REQUEST_BYTES", "service request task description transport is invalid")
  }
  const encoded = taskDescription.slice(prefix.length)
  if (!requestBytesBase64url.safeParse(encoded).success) {
    throw new ServiceRequestPreparationError("INVALID_REQUEST_BYTES", "service request task description encoding is invalid")
  }
  try {
    const decoded = Buffer.from(encoded, "base64url")
    const requestBytes = transport === "base64url"
      ? decoded
      : inflateRawSync(decoded, { maxOutputLength: MAX_SERVICE_REQUEST_BYTES })
    if (requestBytes.length === 0 || requestBytes.length > MAX_SERVICE_REQUEST_BYTES) {
      throw new ServiceRequestPreparationError("REQUEST_TOO_LARGE", "service request task description exceeds the decoded byte limit")
    }
    return requestBytes
  } catch (error) {
    if (error instanceof ServiceRequestPreparationError) throw error
    throw new ServiceRequestPreparationError("INVALID_REQUEST_BYTES", "service request task description payload is invalid")
  }
}

const assertHealthBinding = (
  task: Extract<TaskSpec, { category: "health" }>,
  request: z.infer<typeof healthGuardEvaluationInput>,
): string => {
  requireEqual(request.task, task, "HealthGuard embedded task does not match the marketplace task")
  requireEqual(
    {
      snapshotId: request.snapshot.snapshotId,
      chainId: request.snapshot.chainId,
      borrower: request.snapshot.borrower,
      comptroller: request.snapshot.comptroller,
      poolFamily: request.snapshot.poolFamily,
    },
    {
      snapshotId: task.snapshotId,
      chainId: task.dataChainId,
      borrower: task.target.borrower,
      comptroller: task.target.comptroller,
      poolFamily: task.target.poolFamily,
    },
    "HealthGuard snapshot does not match the marketplace task",
  )
  return request.snapshot.snapshotId
}

const assertRangeBinding = (
  task: Extract<TaskSpec, { category: "rebalancing" }>,
  request: z.infer<typeof rangePilotEvaluationInput>,
  requestHash: string,
): string => {
  const internal = request.task
  requireEqual(
    {
      taskId: task.taskId,
      capability: task.capability,
      identityChainId: task.identityChainId,
      dataChainId: task.dataChainId,
      paymentChainId: task.paymentChainId,
      executionChainId: task.executionChainId,
      snapshotId: task.snapshotId,
      inputHash: task.inputHash,
      positionManager: task.target.positionManager,
      positionTokenId: task.target.positionTokenId,
      controllingAccount: task.target.controllingAccount,
      pool: task.target.pool,
      token0BudgetUnits: task.constraints.token0BudgetUnits,
      token1BudgetUnits: task.constraints.token1BudgetUnits,
      minimumRangeWidthTicks: task.constraints.minimumRangeWidthTicks,
      targetRangeWidthTicks: task.constraints.targetRangeWidthTicks,
      maximumRangeWidthTicks: task.constraints.maximumRangeWidthTicks,
      maximumSlippageBps: task.constraints.maximumSlippageBps,
      gasBudgetWei: task.constraints.gasBudgetWei,
      cooldownSeconds: task.constraints.cooldownSeconds,
      executionMode: task.constraints.executionMode,
    },
    {
      taskId: internal.taskId,
      capability: internal.capability,
      identityChainId: 97,
      dataChainId: internal.chainId,
      paymentChainId: 97,
      executionChainId: null,
      snapshotId: internal.snapshotId,
      inputHash: requestHash,
      positionManager: internal.positionManager,
      positionTokenId: internal.positionTokenId,
      controllingAccount: internal.controllingAccount,
      pool: internal.allowedPool.address,
      token0BudgetUnits: internal.constraints.token0BudgetUnits,
      token1BudgetUnits: internal.constraints.token1BudgetUnits,
      minimumRangeWidthTicks: internal.constraints.minimumRangeWidthTicks,
      targetRangeWidthTicks: internal.constraints.targetRangeWidthTicks,
      maximumRangeWidthTicks: internal.constraints.maximumRangeWidthTicks,
      maximumSlippageBps: internal.constraints.maximumSlippageBps,
      gasBudgetWei: internal.constraints.gasBudgetWei,
      cooldownSeconds: internal.constraints.cooldownSeconds,
      executionMode: internal.constraints.executionMode,
    },
    "RangePilot request does not match the marketplace task or exact input hash",
  )
  requireEqual(
    {
      snapshotId: request.snapshot.snapshotId,
      chainId: request.snapshot.chainId,
      positionManager: request.snapshot.positionManager,
      positionTokenId: request.snapshot.positionTokenId,
    },
    {
      snapshotId: internal.snapshotId,
      chainId: internal.chainId,
      positionManager: internal.positionManager,
      positionTokenId: internal.positionTokenId,
    },
    "RangePilot request and snapshot identities differ",
  )
  return request.snapshot.snapshotId
}

const assertGridBinding = (
  task: Extract<TaskSpec, { category: "grid" }>,
  request: z.infer<typeof gridQuantEvaluationInput>,
  buyer: string,
  requestHash: string,
): string => {
  const internal = request.task
  const parameters = internal.parameters
  requireEqual(
    {
      taskId: task.taskId,
      capability: task.capability,
      identityChainId: task.identityChainId,
      dataChainId: task.dataChainId,
      paymentChainId: task.paymentChainId,
      executionChainId: task.executionChainId,
      snapshotId: task.snapshotId,
      inputHash: task.inputHash,
      target: task.target,
      constraints: task.constraints,
    },
    {
      taskId: internal.taskId,
      capability: internal.capability,
      identityChainId: internal.identityChainId,
      dataChainId: internal.dataChainId,
      paymentChainId: internal.paymentChainId,
      executionChainId: internal.executionChainId,
      snapshotId: internal.snapshotId,
      inputHash: requestHash,
      target: {
        baseToken: internal.pair.baseToken.address,
        quoteToken: internal.pair.quoteToken.address,
        pool: internal.pair.pool,
      },
      constraints: {
        lowerPriceUnits: parameters.lowerPriceUnits,
        upperPriceUnits: parameters.upperPriceUnits,
        gridCount: parameters.gridCount,
        spacing: parameters.spacing,
        principalUnits: parameters.principalQuoteUnits,
        orderSizeFloorUnits: parameters.orderSizeFloorQuoteUnits,
        maxInventoryExposureUnits: parameters.maxBaseInventoryUnits,
        slippageBps: parameters.slippageBps,
        cooldownSeconds: parameters.cooldownSeconds,
        expiryUtc: parameters.expiryUtc,
        mode: parameters.executionMode === "analysis" ? "analysis" : "execute",
      },
    },
    "GridQuant request does not match the marketplace task or exact input hash",
  )
  requireBuyer(internal.requester, buyer)
  requireBuyer(request.snapshot.requester, buyer)
  if (!request.snapshot.analysisAuthorized) failBinding("GridQuant analysis is not authorized")
  requireEqual(
    { snapshotId: request.snapshot.snapshotId, chainId: request.snapshot.chainId, pair: request.snapshot.pair },
    { snapshotId: internal.snapshotId, chainId: internal.dataChainId, pair: internal.pair },
    "GridQuant request and snapshot identities differ",
  )
  return request.snapshot.snapshotId
}

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator

const assertYieldBinding = (
  task: Extract<TaskSpec, { category: "yield" }>,
  request: z.infer<typeof yieldScoutEvaluationInput>,
  buyer: string,
  requestHash: string,
): string => {
  const minimumImprovement = ceilDiv(
    BigInt(request.amountUnits) * BigInt(task.constraints.minImprovementBps),
    10_000n,
  ).toString()
  requireEqual(
    {
      taskId: task.taskId,
      capability: task.capability,
      identityChainId: task.identityChainId,
      dataChainId: task.dataChainId,
      paymentChainId: task.paymentChainId,
      executionChainId: task.executionChainId,
      snapshotId: task.snapshotId,
      inputHash: task.inputHash,
      asset: task.target.asset,
      amountUnits: task.target.amountUnits,
      horizonSeconds: task.constraints.horizonSeconds,
      allowedProtocols: [...task.constraints.allowedProtocols].sort(),
      allowLpExposure: task.constraints.allowLpExposure,
      minMarketLiquidityUnits: task.constraints.minMarketLiquidityUnits,
      concentrationCapBps: task.constraints.concentrationCapBps,
      gasAllowanceWei: task.constraints.gasAllowanceWei,
      minimumImprovementUnits: minimumImprovement,
      mode: task.constraints.mode,
    },
    {
      taskId: request.taskId,
      capability: request.capability,
      identityChainId: request.identityChainId,
      dataChainId: request.dataChainId,
      paymentChainId: request.paymentChainId,
      executionChainId: request.executionChainId,
      snapshotId: request.snapshot.snapshotId,
      inputHash: requestHash,
      asset: request.asset.address,
      amountUnits: request.amountUnits,
      horizonSeconds: request.holdingHorizonSeconds,
      allowedProtocols: [...request.allowedProtocols].sort(),
      allowLpExposure: !request.noLpExposure,
      minMarketLiquidityUnits: request.minimumLiquidityUnits,
      concentrationCapBps: request.concentrationCapBps,
      gasAllowanceWei: request.gasAllowanceUnits,
      minimumImprovementUnits: request.minimumImprovementUnits,
      mode: request.capability === "analysis" ? "analysis" : "execute",
    },
    "YieldScout request does not match the marketplace task or exact input hash",
  )
  requireBuyer(request.requester, buyer)
  if (!request.analysisAuthorized) failBinding("YieldScout analysis is not authorized")
  requireEqual(
    { chainId: request.snapshot.chainId, asset: request.snapshot.asset },
    { chainId: request.dataChainId, asset: request.asset },
    "YieldScout request and snapshot identities differ",
  )
  return request.snapshot.snapshotId
}

const parseRequest = (
  envelope: ServiceRequestEnvelope,
  buyer: string,
  requestValue: unknown,
  requestHash: string,
): { snapshotId: string; inputBinding: ServiceRequestInputBinding } => {
  try {
    switch (envelope.task.category) {
      case "health": {
        const request = healthGuardEvaluationInput.parse(requestValue)
        if (
          request.task.capability !== "analysis" ||
          request.task.constraints.mode !== "notify" ||
          request.task.target.poolFamily !== "venus-core"
        ) {
          failCapability("HealthGuard accepts one-shot venus-core analysis requests only")
        }
        return { snapshotId: assertHealthBinding(envelope.task, request), inputBinding: "LEGACY_EMBEDDED_TASK" }
      }
      case "rebalancing": {
        const request = rangePilotEvaluationInput.parse(requestValue)
        if (
          request.task.capability !== "analysis" ||
          request.task.constraints.executionMode !== "analysis" ||
          request.task.chainId !== 56 ||
          request.snapshot.chainId !== 56
        ) {
          failCapability("RangePilot accepts BSC one-shot analysis requests only")
        }
        return { snapshotId: assertRangeBinding(envelope.task, request, requestHash), inputBinding: "EXACT_REQUEST_BYTES" }
      }
      case "grid": {
        const request = gridQuantEvaluationInput.parse(requestValue)
        if (request.task.capability !== "analysis" || request.task.parameters.executionMode !== "analysis") {
          failCapability("GridQuant accepts one-shot analysis requests only")
        }
        return { snapshotId: assertGridBinding(envelope.task, request, buyer, requestHash), inputBinding: "EXACT_REQUEST_BYTES" }
      }
      case "yield": {
        const request = yieldScoutEvaluationInput.parse(requestValue)
        if (request.capability !== "analysis" || request.executionChainId !== null) {
          failCapability("YieldScout accepts one-shot analysis requests only")
        }
        return { snapshotId: assertYieldBinding(envelope.task, request, buyer, requestHash), inputBinding: "EXACT_REQUEST_BYTES" }
      }
      case "security":
        return failBinding("security seller requests are not supported")
    }
  } catch (error) {
    if (error instanceof ServiceRequestPreparationError) throw error
    throw new ServiceRequestPreparationError("SELLER_SCHEMA_MISMATCH", "request bytes do not match the seller's closed schema")
  }
}

export const prepareServiceRequest = (
  value: unknown,
  expectedBuyer: string,
  options: PrepareServiceRequestOptions = {},
): PreparedServiceRequest => {
  const parsedEnvelope = serviceRequestEnvelope.safeParse(value)
  if (!parsedEnvelope.success) {
    throw new ServiceRequestPreparationError("INVALID_ENVELOPE", "service request envelope is invalid")
  }
  const envelope = parsedEnvelope.data
  if (envelope.task.category === "security") {
    throw new ServiceRequestPreparationError("INVALID_ENVELOPE", "security seller requests are not supported")
  }
  const parsedBuyer = address.safeParse(expectedBuyer)
  if (!parsedBuyer.success) {
    throw new ServiceRequestPreparationError("INVALID_ENVELOPE", "expected buyer address is invalid")
  }
  const buyer = parsedBuyer.data
  const requestBytes = Buffer.from(envelope.request.bytesBase64url, "base64url")
  if (requestBytes.length === 0) {
    throw new ServiceRequestPreparationError("INVALID_REQUEST_BYTES", "service request bytes are empty")
  }
  if (requestBytes.length > MAX_SERVICE_REQUEST_BYTES) {
    throw new ServiceRequestPreparationError("REQUEST_TOO_LARGE", "service request exceeds the decoded byte limit")
  }
  let requestText: string
  let requestValue: unknown
  try {
    requestText = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)
    requestValue = JSON.parse(requestText) as unknown
  } catch {
    throw new ServiceRequestPreparationError("INVALID_REQUEST_BYTES", "service request is not valid UTF-8 JSON")
  }
  const requestKeccak256 = keccak256(requestBytes)
  const binding = parseRequest(envelope, buyer, requestValue, requestKeccak256)
  const encodedBytes = envelope.transport === "base64url"
    ? envelope.request.bytesBase64url
    : deflateRawSync(requestBytes).toString("base64url")
  if (encodedBytes.length > MAX_ENCODED_SERVICE_REQUEST_CHARS) {
    throw new ServiceRequestPreparationError("REQUEST_TOO_LARGE", "encoded service request exceeds the seller transport limit")
  }
  const taskDescription = `${envelope.transport === "base64url" ? SERVICE_REQUEST_TRANSPORT_PREFIX : COMPRESSED_SERVICE_REQUEST_TRANSPORT_PREFIX}${encodedBytes}`
  if (
    options.enforceTaskDescriptionLimit !== false &&
    Buffer.byteLength(taskDescription, "utf8") > MAX_SERVICE_TASK_DESCRIPTION_BYTES
  ) {
    throw new ServiceRequestPreparationError(
      "REQUEST_TOO_LARGE",
      `service request task description exceeds the ${MAX_SERVICE_TASK_DESCRIPTION_BYTES}-byte signed quote limit`,
    )
  }
  return {
    schemaVersion: "knot.prepared-service-request/1",
    buyer,
    task: envelope.task,
    taskId: envelope.task.taskId,
    category: envelope.task.category,
    requestSchemaVersion: envelope.request.schemaVersion,
    transport: envelope.transport,
    requestBytesBase64url: envelope.request.bytesBase64url,
    requestByteLength: requestBytes.length,
    requestSha256: sha256(requestBytes),
    requestKeccak256,
    taskInputHash: envelope.task.inputHash,
    taskDescription,
    taskDescriptionSha256: sha256(Buffer.from(taskDescription, "utf8")),
    snapshotId: binding.snapshotId,
    inputBinding: binding.inputBinding,
  }
}
