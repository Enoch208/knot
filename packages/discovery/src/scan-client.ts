import {
  scanAgentPage,
  type DiscoveryCoverage,
  type DiscoveryQuery,
  type RateLimitSnapshot,
  type ScanAgentPage,
} from "./types.ts"

export const SCAN_ORIGIN = "https://8004scan.io"
export const SCAN_BASE_PATH = "/api/v1"

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

export interface ScanClientOptions {
  apiKey?: string
  fetchImpl?: FetchLike
  maxAttempts?: number
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

function retryDelayMilliseconds(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header !== null) {
    const seconds = Number.parseInt(header, 10)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  }
  return 500 * 2 ** attempt
}

export class ScanClient {
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchLike
  private readonly maxAttempts: number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => Date

  constructor(options: ScanClientOptions = {}) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.maxAttempts = options.maxAttempts ?? 3
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => new Date())
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.apiKey !== undefined) headers["x-api-key"] = this.apiKey
    return headers
  }

  async listAgents(query: DiscoveryQuery = {}): Promise<ScanAgentsResult> {
    const requestUri = buildUri(query)
    let lastStatus: number | null = null

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(requestUri, { headers: this.headers() })
      } catch (error) {
        lastStatus = null
        if (attempt + 1 >= this.maxAttempts) {
          throw new ScanUnavailableError(
            requestUri,
            null,
            error instanceof Error ? error.message : String(error),
          )
        }
        await this.sleep(500 * 2 ** attempt)
        continue
      }

      lastStatus = response.status

      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 >= this.maxAttempts) {
          throw new ScanUnavailableError(requestUri, response.status, `status ${response.status}`)
        }
        await this.sleep(retryDelayMilliseconds(response, attempt))
        continue
      }

      if (response.status >= 300) {
        throw new ScanUnavailableError(requestUri, response.status, `status ${response.status}`)
      }

      const body: unknown = await response.json()
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
