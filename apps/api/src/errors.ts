export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "AUTHORITY_MISMATCH"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "RESULT_INCOMPLETE"
  | "UPSTREAM_UNAVAILABLE"

export type SafeFinancialState =
  | "unfunded"
  | "funded_unsettled"
  | "settled"
  | "refunded"
  | "unknown"

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly retryable: boolean
  readonly financialState: SafeFinancialState

  constructor(
    status: number,
    code: ApiErrorCode,
    explanation: string,
    retryable: boolean,
    financialState: SafeFinancialState = "unknown",
  ) {
    super(explanation)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryable = retryable
    this.financialState = financialState
  }
}

export const invalidRequest = (explanation: string): ApiError =>
  new ApiError(400, "INVALID_REQUEST", explanation, false, "unfunded")

export const upstreamUnavailable = (): ApiError =>
  new ApiError(503, "UPSTREAM_UNAVAILABLE", "The durable data store is unavailable.", true)
