import { z } from "zod"
import { taskSpec } from "../../../packages/contracts/src/task.ts"

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const accessScope = z.object({ visibility: z.literal("PRIVATE") }).strict()

export const createTaskRequest = z
  .object({
    task: taskSpec,
    accessScope,
  })
  .strict()

export const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}
