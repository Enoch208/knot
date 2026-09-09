import { z } from "zod"
import { amount, capability, chainId, hexDigest } from "./primitives.ts"
import { categoryPayload } from "./targets.ts"

export const CROSS_NETWORK_EXECUTION_REFUSED =
  "executionChainId must equal dataChainId: analysis of one network never authorizes execution on another"

const envelopeShape = {
  schemaVersion: z.literal("knot.task/1"),
  taskId: z.string().min(1),
  capability,
  identityChainId: chainId,
  dataChainId: chainId,
  paymentChainId: chainId,
  executionChainId: chainId.nullable(),
  serviceFeeLimit: amount,
  managedPrincipal: z.array(amount),
  executionSpendLimits: z.array(amount),
  deadlineUtc: z.iso.datetime(),
  inputHash: hexDigest,
  snapshotId: z.string().min(1).nullable(),
} as const

const withEnvelope = categoryPayload.options.map((option) => option.safeExtend(envelopeShape))

export const taskSpec = z
  .discriminatedUnion("category", withEnvelope as [(typeof withEnvelope)[number], ...typeof withEnvelope])
  .refine((task) => task.executionChainId === null || task.executionChainId === task.dataChainId, {
    message: CROSS_NETWORK_EXECUTION_REFUSED,
  })
  .refine((task) => task.capability !== "execution" || task.executionChainId !== null, {
    message: "an execution task must name the network it executes on",
  })
  .refine((task) => task.capability === "execution" || task.executionSpendLimits.length === 0, {
    message: "only an execution task may carry spend limits",
  })

export type TaskSpec = z.infer<typeof taskSpec>

export const ERROR_CODES = [
  "UNSUPPORTED_POSITION",
  "STALE_SNAPSHOT",
  "QUOTE_EXPIRED",
  "CAPABILITY_CHANGED",
  "PAYMENT_PENDING_RECONCILIATION",
  "INSUFFICIENT_GAS",
  "AUTHORITY_MISMATCH",
  "RESULT_INCOMPLETE",
  "DELIVERABLE_HASH_MISMATCH",
  "UPSTREAM_UNAVAILABLE",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface KnotFailure {
  code: ErrorCode
  explanation: string
  retryable: boolean
  correlationId: string
  financialState: "unfunded" | "funded_unsettled" | "settled" | "refunded" | "unknown"
}

export const isKnotFailure = (value: unknown): value is KnotFailure =>
  typeof value === "object" &&
  value !== null &&
  ERROR_CODES.includes((value as KnotFailure).code)
