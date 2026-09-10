export class RetentionPolicyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "RetentionPolicyError"
    this.code = code
  }
}

export const ERASURE_TOMBSTONE = "\\x00"

export interface RetainedRequest {
  id: string
  retentionUntil: Date | null
  erasedAt: Date | null
  requestByteLength: number
}

export interface ErasureDecision {
  id: string
  erase: boolean
  reason: string
}

const MINIMUM_RETENTION_SECONDS = 60

export function retentionDeadline(createdAt: Date, retentionSeconds: number): Date {
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < MINIMUM_RETENTION_SECONDS) {
    throw new RetentionPolicyError(
      "RETENTION_TOO_SHORT",
      `retention must be at least ${MINIMUM_RETENTION_SECONDS} seconds so a record cannot be erased on arrival`,
    )
  }
  return new Date(createdAt.getTime() + retentionSeconds * 1000)
}

export function decideErasure(request: RetainedRequest, now: Date): ErasureDecision {
  if (request.erasedAt !== null) {
    return { id: request.id, erase: false, reason: "already erased" }
  }
  if (request.retentionUntil === null) {
    return { id: request.id, erase: false, reason: "no retention deadline recorded" }
  }
  if (request.retentionUntil.getTime() > now.getTime()) {
    return { id: request.id, erase: false, reason: "retention has not elapsed" }
  }
  if (request.requestByteLength <= 1) {
    return { id: request.id, erase: false, reason: "payload already reduced to a tombstone" }
  }
  return { id: request.id, erase: true, reason: "retention elapsed" }
}

export function selectErasable(
  requests: readonly RetainedRequest[],
  now: Date,
): { erase: readonly ErasureDecision[]; retain: readonly ErasureDecision[] } {
  const decisions = requests.map((request) => decideErasure(request, now))
  return {
    erase: decisions.filter((decision) => decision.erase),
    retain: decisions.filter((decision) => !decision.erase),
  }
}

export function assertErasureRecord(
  before: { requestSha256: string; requestByteLength: number },
  after: { erasedRequestSha256: string | null; erasedAt: Date | null; requestByteLength: number },
): void {
  if (after.erasedAt === null) {
    throw new RetentionPolicyError("ERASURE_NOT_RECORDED", "an erased record must carry the erasure time")
  }
  if (after.erasedRequestSha256 !== before.requestSha256) {
    throw new RetentionPolicyError(
      "DIGEST_NOT_PRESERVED",
      "erasure must preserve the original payload digest so the record stays verifiable",
    )
  }
  if (after.requestByteLength >= before.requestByteLength) {
    throw new RetentionPolicyError("PAYLOAD_NOT_REDUCED", "erasure must reduce the stored payload")
  }
  if (after.requestByteLength !== 1) {
    throw new RetentionPolicyError("TOMBSTONE_UNEXPECTED", "an erased payload must be a single tombstone byte")
  }
}
