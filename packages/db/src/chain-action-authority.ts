import type { PoolClient } from "pg"
import { ChainActionAuthorityError } from "./errors.ts"

export interface ChainActionAuthorityInput {
  jobId: string
  sessionId: string
  taskId: string
  actionSequence: number
  semanticAction: string
  signerAddress: string
  accountAddress: string
  chainId: 56 | 97
  nonce: string | null
  relayIntentId: string | null
  requestHash: string
}

interface ChainActionAuthorityRow {
  job_task_id: string
  job_buyer: string
  task_buyer: string
  session_owner_address: string
  session_chain_id: 56 | 97
  session_current: boolean
  revoked_at: Date | null
  permissions: unknown
}

interface PermissionRecord {
  taskId: string
  actionSequence: number
  semanticAction: string
  signerAddress: string
  accountAddress: string
  chainId: 56 | 97
  nonce: string | null
  relayIntentId: string | null
  requestHash: string
}

const permissionKeys = [
  "accountAddress",
  "actionSequence",
  "chainId",
  "nonce",
  "relayIntentId",
  "requestHash",
  "semanticAction",
  "signerAddress",
  "taskId",
] as const

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const permission = (value: unknown): PermissionRecord | null => {
  const candidate = record(value)
  if (candidate === null) return null
  if (
    Object.keys(candidate).sort().join("\n") !== [...permissionKeys].sort().join("\n") ||
    typeof candidate.taskId !== "string" ||
    !Number.isSafeInteger(candidate.actionSequence) ||
    typeof candidate.semanticAction !== "string" ||
    typeof candidate.signerAddress !== "string" ||
    typeof candidate.accountAddress !== "string" ||
    (candidate.chainId !== 56 && candidate.chainId !== 97) ||
    (candidate.nonce !== null && typeof candidate.nonce !== "string") ||
    (candidate.relayIntentId !== null && typeof candidate.relayIntentId !== "string") ||
    typeof candidate.requestHash !== "string"
  ) return null
  return candidate as unknown as PermissionRecord
}

const permits = (permissions: unknown, input: ChainActionAuthorityInput): boolean => {
  const envelope = record(permissions)
  if (
    envelope?.schemaVersion !== "knot.chain-action-authority/1" ||
    !Array.isArray(envelope.actions) ||
    Object.keys(envelope).sort().join("\n") !== "actions\nschemaVersion"
  ) return false
  return envelope.actions.some((value) => {
    const allowed = permission(value)
    return allowed !== null &&
      allowed.taskId === input.taskId &&
      allowed.actionSequence === input.actionSequence &&
      allowed.semanticAction === input.semanticAction &&
      allowed.signerAddress.toLowerCase() === input.signerAddress.toLowerCase() &&
      allowed.accountAddress.toLowerCase() === input.accountAddress.toLowerCase() &&
      allowed.chainId === input.chainId &&
      allowed.nonce === input.nonce &&
      allowed.relayIntentId === input.relayIntentId &&
      allowed.requestHash.toLowerCase() === input.requestHash.toLowerCase()
  })
}

export const requireChainActionAuthority = async (
  client: PoolClient,
  input: ChainActionAuthorityInput,
): Promise<void> => {
  const result = await client.query<ChainActionAuthorityRow>(
    "SELECT jobs.task_id AS job_task_id, jobs.buyer AS job_buyer, tasks.buyer AS task_buyer, sessions.owner_address AS session_owner_address, sessions.chain_id AS session_chain_id, sessions.expires_at > clock_timestamp() AS session_current, sessions.revoked_at, sessions.permissions FROM jobs JOIN tasks ON tasks.id = jobs.task_id JOIN sessions ON sessions.id = $2 WHERE jobs.id = $1 FOR UPDATE OF sessions",
    [input.jobId, input.sessionId],
  )
  const row = result.rows[0]
  if (
    !row ||
    row.job_task_id !== input.taskId ||
    row.job_buyer !== row.task_buyer ||
    row.session_owner_address !== row.job_buyer ||
    row.session_chain_id !== input.chainId ||
    row.session_current !== true ||
    row.revoked_at !== null ||
    !permits(row.permissions, input)
  ) {
    throw new ChainActionAuthorityError()
  }
}
