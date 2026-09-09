export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key is already bound to different job intent")
    this.name = "IdempotencyConflictError"
  }
}

export class ConcurrentUpdateError extends Error {
  constructor(resource: string) {
    super(`${resource} changed before the requested update`)
    this.name = "ConcurrentUpdateError"
  }
}

export class LeaseRejectedError extends Error {
  constructor() {
    super("worker lease is missing, expired, or fenced")
    this.name = "LeaseRejectedError"
  }
}
