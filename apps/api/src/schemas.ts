import { z } from "zod"
import { serviceRequestEnvelope } from "../../../packages/contracts/src/service-request.ts"
import { taskSpec } from "../../../packages/contracts/src/task.ts"
import { validateSafeUrl } from "../../../packages/security/src/index.ts"

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const accessScope = z.object({ visibility: z.literal("PRIVATE") }).strict()

export const createTaskRequest = z
  .object({
    task: taskSpec,
    accessScope,
  })
  .strict()

export const createVerifiedQuoteRequest = z.object({}).strict()

const serviceEndpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      return validateSafeUrl(value).hash === ""
    } catch {
      return false
    }
  })

export const createServiceRequest = z
  .object({
    id: identifier,
    endpoint: serviceEndpoint,
    envelope: serviceRequestEnvelope,
  })
  .strict()

export const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}
