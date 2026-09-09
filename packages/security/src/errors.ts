export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "HTTPS_REQUIRED"
  | "EMBEDDED_CREDENTIALS"
  | "UNSAFE_PORT"
  | "PRIVATE_HOSTNAME"
  | "DNS_UNAVAILABLE"
  | "NON_PUBLIC_ADDRESS"
  | "UNSAFE_HEADER"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_WITHOUT_LOCATION"
  | "REDIRECT_LIMIT"
  | "UNSAFE_REDIRECT"
  | "UPSTREAM_TIMEOUT"
  | "REQUEST_ABORTED"
  | "UPSTREAM_UNAVAILABLE"

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = "SafeFetchError"
    this.code = code
  }
}
