import { request as httpsRequest } from "node:https"
import type { IncomingHttpHeaders } from "node:http"
import { resolvePublicAddresses, systemResolver, validateSafeUrl, type ResolvedAddress, type SafeResolver } from "./address-policy.ts"
import { SafeFetchError } from "./errors.ts"

export type SafeFetchMethod = "GET" | "HEAD" | "POST"

export interface SafeFetchTransportRequest {
  url: URL
  address: ResolvedAddress
  method: SafeFetchMethod
  headers: Readonly<Record<string, string>>
  body: Uint8Array | null
  timeoutMs: number
  maxBytes: number
  signal: AbortSignal | undefined
}

export interface SafeFetchTransportResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body: Uint8Array
}

export type SafeFetchTransport = (request: SafeFetchTransportRequest) => Promise<SafeFetchTransportResponse>

export interface SafeFetchOptions {
  method?: SafeFetchMethod
  headers?: Readonly<Record<string, string>>
  body?: string | Uint8Array
  timeoutMs?: number
  maxBytes?: number
  maxRequestBytes?: number
  maxRedirects?: number
  resolver?: SafeResolver
  transport?: SafeFetchTransport
  signal?: AbortSignal
}

export interface SafeFetchResponse extends SafeFetchTransportResponse {
  url: string
  redirects: readonly string[]
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const allowedHeaders = new Set(["accept", "authorization", "content-type", "user-agent", "x-api-key"])
const sensitiveHeaders = new Set(["authorization", "x-api-key"])

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 100, 60_000, "timeoutMs")
  const deadlineAt = Date.now() + timeoutMs
  const maxBytes = boundedInteger(options.maxBytes ?? 1_048_576, 1, 10_485_760, "maxBytes")
  const maxRequestBytes = boundedInteger(options.maxRequestBytes ?? 65_536, 0, 1_048_576, "maxRequestBytes")
  const maxRedirects = boundedInteger(options.maxRedirects ?? 3, 0, 10, "maxRedirects")
  const resolver = options.resolver ?? systemResolver
  const transport = options.transport ?? nodeHttpsTransport
  if (options.signal?.aborted) throw new SafeFetchError("REQUEST_ABORTED", "outbound request was aborted")
  let method = options.method ?? "GET"
  let body = options.body === undefined ? null : typeof options.body === "string" ? Buffer.from(options.body) : options.body
  if (body && body.byteLength > maxRequestBytes) throw new SafeFetchError("REQUEST_TOO_LARGE", "outbound request body exceeds the configured limit")
  const headers = safeHeaders(options.headers ?? {})
  const redirects: string[] = []
  let url = validateSafeUrl(input)
  for (;;) {
    const addresses = await beforeDeadline(resolvePublicAddresses(url, resolver), deadlineAt, options.signal)
    const remainingMs = remainingDeadlineMs(deadlineAt)
    const result = await beforeDeadline(
      transport({ url, address: addresses[0]!, method, headers, body, timeoutMs: remainingMs, maxBytes, signal: options.signal }),
      deadlineAt,
      options.signal,
    )
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
      throw new SafeFetchError("UPSTREAM_UNAVAILABLE", "outbound response carried an invalid status")
    }
    if (result.body.byteLength > maxBytes) throw new SafeFetchError("RESPONSE_TOO_LARGE", "outbound response exceeds the configured limit")
    const responseHeaders = lowerCaseHeaders(result.headers)
    if (!redirectStatuses.has(result.status)) return { ...result, headers: responseHeaders, url: url.href, redirects }
    const location = responseHeaders.location
    if (!location) throw new SafeFetchError("REDIRECT_WITHOUT_LOCATION", "outbound redirect omitted its location")
    if (redirects.length >= maxRedirects) throw new SafeFetchError("REDIRECT_LIMIT", "outbound redirect limit was exceeded")
    let next: URL
    try {
      next = validateSafeUrl(new URL(location, url).href)
    } catch (error) {
      if (error instanceof SafeFetchError) throw error
      throw new SafeFetchError("INVALID_URL", "outbound redirect URL is invalid")
    }
    if (next.origin !== url.origin && ((result.status === 307 || result.status === 308) && body
      || Object.keys(headers).some((name) => sensitiveHeaders.has(name)))) {
      throw new SafeFetchError("UNSAFE_REDIRECT", "sensitive outbound request data cannot cross origins through a redirect")
    }
    redirects.push(next.href)
    if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST")) {
      method = "GET"
      body = null
    }
    url = next
  }
}

export async function nodeHttpsTransport(input: SafeFetchTransportRequest): Promise<SafeFetchTransportResponse> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let deadlineTimer: NodeJS.Timeout | null = null
    let abortListener: (() => void) | null = null
    const clearDeadline = (): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      deadlineTimer = null
      if (abortListener) input.signal?.removeEventListener("abort", abortListener)
      abortListener = null
    }
    const finish = (value: SafeFetchTransportResponse): void => {
      if (!settled) {
        settled = true
        clearDeadline()
        resolve(value)
      }
    }
    const fail = (error: SafeFetchError): void => {
      if (!settled) {
        settled = true
        clearDeadline()
        reject(error)
      }
    }
    const headers: Record<string, string> = { ...input.headers, host: input.url.host }
    if (input.body) headers["content-length"] = String(input.body.byteLength)
    const request = httpsRequest({
      hostname: input.address.address,
      family: input.address.family,
      port: 443,
      servername: input.url.hostname,
      method: input.method,
      path: `${input.url.pathname}${input.url.search}`,
      headers,
    }, (response) => {
      const chunks: Buffer[] = []
      let length = 0
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength
        if (length > input.maxBytes) {
          response.destroy()
          fail(new SafeFetchError("RESPONSE_TOO_LARGE", "outbound response exceeds the configured limit"))
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => finish({
        status: response.statusCode ?? 0,
        headers: normalizedHeaders(response.headers),
        body: Buffer.concat(chunks),
      }))
      response.on("error", () => fail(new SafeFetchError("UPSTREAM_UNAVAILABLE", "outbound response did not complete")))
    })
    deadlineTimer = setTimeout(() => {
      timedOut = true
      request.destroy()
    }, input.timeoutMs)
    abortListener = () => {
      aborted = true
      request.destroy()
    }
    input.signal?.addEventListener("abort", abortListener, { once: true })
    request.on("error", () => fail(new SafeFetchError(
      aborted ? "REQUEST_ABORTED" : timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      aborted ? "outbound request was aborted" : timedOut ? "outbound request timed out" : "outbound request did not complete",
    )))
    if (input.signal?.aborted) abortListener()
    else request.end(input.body ?? undefined)
  })
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number, signal?: AbortSignal): Promise<T> {
  const remainingMs = remainingDeadlineMs(deadlineAt)
  if (signal?.aborted) throw new SafeFetchError("REQUEST_ABORTED", "outbound request was aborted")
  return await new Promise<T>((resolve, reject) => {
    const finish = (operation: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      operation()
    }
    const abort = (): void => finish(() => reject(new SafeFetchError("REQUEST_ABORTED", "outbound request was aborted")))
    const timer = setTimeout(
      () => finish(() => reject(new SafeFetchError("UPSTREAM_TIMEOUT", "outbound request exceeded its total deadline"))),
      remainingMs,
    )
    signal?.addEventListener("abort", abort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        finish(() => reject(error))
      },
    )
  })
}

function remainingDeadlineMs(deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) throw new SafeFetchError("UPSTREAM_TIMEOUT", "outbound request exceeded its total deadline")
  return remainingMs
}

function safeHeaders(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const output: Record<string, string> = { "user-agent": "KNOT-safe-fetch/1" }
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase()
    if (!allowedHeaders.has(name)) throw new SafeFetchError("UNSAFE_HEADER", "outbound request contains a disallowed header")
    if (value.length > 8_192 || value.includes("\r") || value.includes("\n")) {
      throw new SafeFetchError("UNSAFE_HEADER", "outbound request contains an invalid header value")
    }
    output[name] = value
  }
  return output
}

function lowerCaseHeaders(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]))
}

function normalizedHeaders(input: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string") output[name.toLowerCase()] = value
    if (Array.isArray(value)) output[name.toLowerCase()] = value.join(", ")
  }
  return output
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} is outside its supported range`)
  return value
}
