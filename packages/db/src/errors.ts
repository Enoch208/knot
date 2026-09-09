export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key is already bound to different job intent")
    this.name = "IdempotencyConflictError"
  }
}

export class TaskDeadlineElapsedError extends Error {
  constructor() {
    super("task deadline elapsed before service request creation")
    this.name = "TaskDeadlineElapsedError"
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

export class ChainActionAuthorityError extends Error {
  constructor() {
    super("chain action is not bound to a current authority session and job task")
    this.name = "ChainActionAuthorityError"
  }
}

export class ChainActionIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChainActionIntegrityError"
  }
}
