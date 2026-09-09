import {
  scanAgentPage,
  type DiscoveryCoverage,
  type DiscoveryQuery,
  type RateLimitSnapshot,
  type ScanAgentPage,
} from "./types.ts"
import { SafeFetchError, safeFetch } from "../../security/src/index.ts"

export const SCAN_ORIGIN = "https://8004scan.io"
export const SCAN_BASE_PATH = "/api/v1"

export interface ScanFetchInit {
  headers: Record<string, string>
  redirect: "manual"
  signal: AbortSignal
}

export type FetchLike = (url: string, init: ScanFetchInit) => Promise<Response>

export interface ScanClientOptions {
  apiKey?: string
  fetchImpl?: FetchLike
  maxAttempts?: number
  timeoutMs?: number
  maxResponseBytes?: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}

export class ScanUnavailableError extends Error {
  readonly requestUri: string
  readonly statusCode: number | null

  constructor(requestUri: string, statusCode: number | null, reason: string) {
    super(`8004scan discovery unavailable (${reason})`)
    this.name = "ScanUnavailableError"
    this.requestUri = requestUri
    this.statusCode = statusCode
  }
}

export interface ScanAgentsResult {
  page: ScanAgentPage
  coverage: DiscoveryCoverage
  rateLimit: RateLimitSnapshot
}

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const redirectStatuses = new Set([301, 302, 303, 307, 308])

interface ScanResponse {
  status: number
  headers: Headers
  body: Uint8Array | null
}

const parseCount = (value: string | null): number | null => {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function buildUri(query: DiscoveryQuery): string {
  const url = new URL(`${SCAN_BASE_PATH}/agents`, SCAN_ORIGIN)
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  url.searchParams.set("limit", String(limit))
  if (query.chainId !== undefined) url.searchParams.set("chain_id", String(query.chainId))
  if (query.search !== undefined && query.search.trim() !== "") {
    url.searchParams.set("search", query.search.trim())
  }
  if (query.cursor !== undefined && query.cursor !== "") url.searchParams.set("cursor", query.cursor)
  return url.toString()
}

function retryDelayMilliseconds(response: ScanResponse, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header !== null) {
    const seconds = Number.parseInt(header, 10)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  }
  return 500 * 2 ** attempt
}

export class ScanClient {
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchLike | undefined
  private readonly maxAttempts: number
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => Date

  constructor(options: ScanClientOptions = {}) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl
    this.maxAttempts = options.maxAttempts ?? 3
    this.timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 60_000, "timeoutMs")
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      10_485_760,
      "maxResponseBytes",
    )
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => new Date())
  }

  private async request(requestUri: string, deadlineAt: number): Promise<ScanResponse> {
    const remainingMs = remainingDeadlineMs(deadlineAt)
    if (this.fetchImpl === undefined) {
      try {
        const response = await safeFetch(requestUri, {
          headers: this.headers(),
          maxBytes: this.maxResponseBytes,
          maxRedirects: 0,
          timeoutMs: remainingMs,
        })
        return {
          status: response.status,
          headers: new Headers(response.headers),
          body: response.body,
        }
      } catch (error) {
        if (error instanceof SafeFetchError && [
          "REDIRECT_LIMIT",
          "RESPONSE_TOO_LARGE",
          "UNSAFE_HEADER",
          "UNSAFE_REDIRECT",
        ].includes(error.code)) {
          throw new ScanUnavailableError(requestUri, null, error.message)
        }
        throw error
      }
    }

    const controller = new AbortController()
    try {
      const response = await beforeDeadline(
        this.fetchImpl(requestUri, {
          headers: this.headers(),
          redirect: "manual",
          signal: controller.signal,
        }),
        deadlineAt,
        () => controller.abort(),
      )
      if (response.redirected || redirectStatuses.has(response.status)) {
        throw new ScanUnavailableError(requestUri, response.status, "redirect refused")
      }
      const body = response.status < 300
        ? await readBoundedBody(requestUri, response, this.maxResponseBytes, deadlineAt, controller)
        : null
      return { status: response.status, headers: response.headers, body }
    } finally {
      controller.abort()
    }
  }

  private async waitForRetry(delayMs: number, deadlineAt: number, requestUri: string, status: number | null): Promise<void> {
    if (delayMs >= remainingDeadlineMs(deadlineAt)) {
      throw new ScanUnavailableError(requestUri, status, "total deadline exhausted before retry")
    }
    try {
      await beforeDeadline(this.sleep(delayMs), deadlineAt)
    } catch (error) {
      throw new ScanUnavailableError(
        requestUri,
        status,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.apiKey !== undefined) headers["x-api-key"] = this.apiKey
    return headers
  }

  async listAgents(query: DiscoveryQuery = {}): Promise<ScanAgentsResult> {
    const requestUri = buildUri(query)
    const deadlineAt = Date.now() + this.timeoutMs
    let lastStatus: number | null = null

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response: ScanResponse
      try {
        response = await this.request(requestUri, deadlineAt)
      } catch (error) {
        if (error instanceof ScanUnavailableError) throw error
        lastStatus = null
        if (attempt + 1 >= this.maxAttempts) {
          throw new ScanUnavailableError(
            requestUri,
            null,
            error instanceof Error ? error.message : String(error),
          )
        }
        await this.waitForRetry(500 * 2 ** attempt, deadlineAt, requestUri, null)
        continue
      }

      lastStatus = response.status

      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 >= this.maxAttempts) {
          throw new ScanUnavailableError(requestUri, response.status, `status ${response.status}`)
        }
        await this.waitForRetry(
          retryDelayMilliseconds(response, attempt),
          deadlineAt,
          requestUri,
          response.status,
        )
        continue
      }

      if (response.status >= 300) {
        throw new ScanUnavailableError(requestUri, response.status, `status ${response.status}`)
      }

      let body: unknown
      try {
        body = JSON.parse(Buffer.from(response.body ?? new Uint8Array()).toString("utf8")) as unknown
      } catch {
        throw new ScanUnavailableError(requestUri, response.status, "unrecognised index payload")
      }
      const parsed = scanAgentPage.safeParse(body)
      if (!parsed.success) {
        throw new ScanUnavailableError(requestUri, response.status, "unrecognised index payload")
      }

      const observedAtUtc = this.now().toISOString()
      return {
        page: parsed.data,
        coverage: {
          source: "8004scan/api/v1/agents",
          requestUri,
          observedAtUtc,
          returnedCount: parsed.data.items.length,
          matchingTotal: parsed.data.total,
          hasMore: parsed.data.has_more,
          nextCursor: parsed.data.next_cursor ?? null,
          filter: query,
        },
        rateLimit: {
          remainingMinute: parseCount(response.headers.get("x-ratelimit-remaining-minute")),
          remainingDay: parseCount(response.headers.get("x-ratelimit-remaining-day")),
        },
      }
    }

    throw new ScanUnavailableError(requestUri, lastStatus, "retries exhausted")
  }
}

async function readBoundedBody(
  requestUri: string,
  response: Response,
  maxBytes: number,
  deadlineAt: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new ScanUnavailableError(requestUri, response.status, "response exceeds configured limit")
    }
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const chunk = await beforeDeadline(reader.read(), deadlineAt, () => controller.abort())
    if (chunk.done) break
    length += chunk.value.byteLength
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ScanUnavailableError(requestUri, response.status, "response exceeds configured limit")
    }
    chunks.push(chunk.value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  onTimeout?: () => void,
): Promise<T> {
  const remainingMs = remainingDeadlineMs(deadlineAt)
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error("discovery request exceeded its total deadline"))
    }, remainingMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function remainingDeadlineMs(deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) throw new Error("discovery request exceeded its total deadline")
  return remainingMs
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside its supported range`)
  }
  return value
}
