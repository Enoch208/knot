import { createHash } from "node:crypto"
import { z } from "zod"
import { validateSafeUrl } from "./address-policy.ts"
import { SafeFetchError } from "./errors.ts"
import { safeFetch, type SafeFetchOptions, type SafeFetchResponse } from "./safe-fetch.ts"

const MAX_OAUTH_BYTES = 16_384
const MAX_INVOCATION_REQUEST_BYTES = 16_384
const MAX_INVOCATION_RESPONSE_BYTES = 131_072

const descriptorSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    origin: z.url().max(2_048),
    tokenUrl: z.url().max(2_048),
    invocationUrl: z.url().max(2_048),
    oauthScope: z.string().min(1).max(256).regex(/^[A-Za-z0-9:._/-]+$/),
  })
  .strict()

const visibleSecret = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))

const credentialsSchema = z
  .object({
    clientId: visibleSecret(1, 256),
    clientSecret: visibleSecret(16, 4_096),
  })
  .strict()

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8_192).regex(/^[A-Za-z0-9._~+/-]+={0,2}$/),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().min(1).max(900),
    scope: z.string().min(1).max(256),
  })
  .strict()

const dataPartSchema = z
  .object({
    kind: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()

const messageSchema = z
  .object({
    kind: z.literal("message"),
    role: z.literal("agent"),
    messageId: z.string().min(1).max(256),
    parts: z.array(dataPartSchema).length(1),
    contextId: z.string().min(1).max(256).optional(),
    taskId: z.string().min(1).max(256).optional(),
  })
  .strict()

const rpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1).max(128),
    result: messageSchema,
  })
  .strict()

const invocationSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()

export interface OwnedSellerDescriptor {
  key: string
  origin: string
  tokenUrl: string
  invocationUrl: string
  oauthScope: string
}

export interface OwnedSellerCredentials {
  clientId: string
  clientSecret: string
}

export interface OwnedSellerNegotiationInput {
  requestId: string
  data: Readonly<Record<string, unknown>>
  signal?: AbortSignal
}

export interface OwnedSellerNegotiationMetrics {
  sellerKey: string
  oauthLatencyMilliseconds: number
  invocationLatencyMilliseconds: number
  responseByteLength: number
  responseSha256: `0x${string}`
}

export interface OwnedSellerNegotiationResult {
  payload: Readonly<Record<string, unknown>>
  metrics: OwnedSellerNegotiationMetrics
}

export type OwnedSellerClientErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "REQUEST_ABORTED"
  | "OAUTH_UNAVAILABLE"
  | "OAUTH_RESPONSE_INVALID"
  | "SELLER_UNAVAILABLE"
  | "SELLER_RESPONSE_INVALID"

export class OwnedSellerClientError extends Error {
  readonly code: OwnedSellerClientErrorCode
  readonly retryable: boolean

  constructor(code: OwnedSellerClientErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = "OwnedSellerClientError"
    this.code = code
    this.retryable = retryable
  }
}

export type OwnedSellerSafeFetch = (input: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>

export interface OwnedSellerClientOptions {
  timeoutMilliseconds?: number
  fetch?: OwnedSellerSafeFetch
  nowMilliseconds?: () => number
}

export class OwnedSellerClient {
  readonly #descriptor: Readonly<OwnedSellerDescriptor>
  readonly #credentials: Readonly<OwnedSellerCredentials>
  readonly #timeoutMilliseconds: number
  readonly #fetch: OwnedSellerSafeFetch
  readonly #nowMilliseconds: () => number

  constructor(
    descriptor: OwnedSellerDescriptor,
    credentials: OwnedSellerCredentials,
    options: OwnedSellerClientOptions = {},
  ) {
    const parsedDescriptor = descriptorSchema.safeParse(descriptor)
    const parsedCredentials = credentialsSchema.safeParse(credentials)
    if (!parsedDescriptor.success || !parsedCredentials.success) {
      throw new OwnedSellerClientError("INVALID_CONFIGURATION", "owned seller client configuration is invalid", false)
    }
    let origin: URL
    let tokenUrl: URL
    let invocationUrl: URL
    try {
      origin = validateSafeUrl(parsedDescriptor.data.origin)
      tokenUrl = validateSafeUrl(parsedDescriptor.data.tokenUrl)
      invocationUrl = validateSafeUrl(parsedDescriptor.data.invocationUrl)
    } catch {
      throw new OwnedSellerClientError("INVALID_CONFIGURATION", "owned seller client configuration is invalid", false)
    }
    if (
      origin.origin !== parsedDescriptor.data.origin ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      tokenUrl.href !== `${origin.origin}/oauth/token` ||
      invocationUrl.href !== `${origin.origin}/`
    ) {
      throw new OwnedSellerClientError("INVALID_CONFIGURATION", "owned seller client configuration is invalid", false)
    }
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 500 || timeoutMilliseconds > 30_000) {
      throw new OwnedSellerClientError("INVALID_CONFIGURATION", "owned seller client configuration is invalid", false)
    }
    this.#descriptor = Object.freeze({ ...parsedDescriptor.data })
    this.#credentials = Object.freeze({ ...parsedCredentials.data })
    this.#timeoutMilliseconds = timeoutMilliseconds
    this.#fetch = options.fetch ?? safeFetch
    this.#nowMilliseconds = options.nowMilliseconds ?? Date.now
    Object.freeze(this)
  }

  async negotiate(input: OwnedSellerNegotiationInput): Promise<OwnedSellerNegotiationResult> {
    const parsedInput = invocationSchema.safeParse({ requestId: input.requestId, data: input.data })
    if (!parsedInput.success) {
      throw new OwnedSellerClientError("INVALID_REQUEST", "owned seller negotiation request is invalid", false)
    }
    const rpcBody = stringifyJson({
      jsonrpc: "2.0",
      id: parsedInput.data.requestId,
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: parsedInput.data.requestId,
          parts: [{ kind: "data", data: parsedInput.data.data }],
        },
      },
    })
    if (Buffer.byteLength(rpcBody, "utf8") > MAX_INVOCATION_REQUEST_BYTES) {
      throw new OwnedSellerClientError("INVALID_REQUEST", "owned seller negotiation request is invalid", false)
    }
    const deadlineMilliseconds = this.#nowMilliseconds() + this.#timeoutMilliseconds
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#credentials.clientId,
      client_secret: this.#credentials.clientSecret,
      scope: this.#descriptor.oauthScope,
    }).toString()
    const oauthStarted = this.#nowMilliseconds()
    const tokenResponse = await this.performFetch(
      this.#descriptor.tokenUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
        maxBytes: MAX_OAUTH_BYTES,
        maxRequestBytes: MAX_OAUTH_BYTES,
        maxRedirects: 0,
        timeoutMs: this.remainingMilliseconds(deadlineMilliseconds, "OAUTH_UNAVAILABLE"),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "OAUTH_UNAVAILABLE",
    )
    const oauthLatencyMilliseconds = elapsed(oauthStarted, this.#nowMilliseconds())
    if (tokenResponse.status !== 200 || !isJson(tokenResponse.headers["content-type"])) {
      throw new OwnedSellerClientError("OAUTH_RESPONSE_INVALID", "owned seller OAuth response is invalid", false)
    }
    const tokenValue = parseJson(tokenResponse.body)
    const parsedToken = tokenResponseSchema.safeParse(tokenValue)
    if (!parsedToken.success || parsedToken.data.scope !== this.#descriptor.oauthScope) {
      throw new OwnedSellerClientError("OAUTH_RESPONSE_INVALID", "owned seller OAuth response is invalid", false)
    }
    const invocationStarted = this.#nowMilliseconds()
    const invocationResponse = await this.performFetch(
      this.#descriptor.invocationUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${parsedToken.data.access_token}`,
          "content-type": "application/json",
        },
        body: rpcBody,
        maxBytes: MAX_INVOCATION_RESPONSE_BYTES,
        maxRequestBytes: MAX_INVOCATION_REQUEST_BYTES,
        maxRedirects: 0,
        timeoutMs: this.remainingMilliseconds(deadlineMilliseconds, "SELLER_UNAVAILABLE"),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "SELLER_UNAVAILABLE",
    )
    const invocationLatencyMilliseconds = elapsed(invocationStarted, this.#nowMilliseconds())
    if (invocationResponse.status !== 200 || !isJson(invocationResponse.headers["content-type"])) {
      throw new OwnedSellerClientError("SELLER_RESPONSE_INVALID", "owned seller response is invalid", false)
    }
    const parsedResponse = rpcResponseSchema.safeParse(parseJson(invocationResponse.body))
    if (!parsedResponse.success || parsedResponse.data.id !== parsedInput.data.requestId) {
      throw new OwnedSellerClientError("SELLER_RESPONSE_INVALID", "owned seller response is invalid", false)
    }
    const payload = parsedResponse.data.result.parts[0]?.data
    if (payload === undefined) {
      throw new OwnedSellerClientError("SELLER_RESPONSE_INVALID", "owned seller response is invalid", false)
    }
    return {
      payload,
      metrics: {
        sellerKey: this.#descriptor.key,
        oauthLatencyMilliseconds,
        invocationLatencyMilliseconds,
        responseByteLength: invocationResponse.body.byteLength,
        responseSha256: sha256(invocationResponse.body),
      },
    }
  }

  private remainingMilliseconds(deadlineMilliseconds: number, code: "OAUTH_UNAVAILABLE" | "SELLER_UNAVAILABLE"): number {
    const remaining = deadlineMilliseconds - this.#nowMilliseconds()
    if (remaining < 100) {
      throw new OwnedSellerClientError(code, "owned seller request exceeded its deadline", true)
    }
    return remaining
  }

  private async performFetch(
    url: string,
    options: SafeFetchOptions,
    code: "OAUTH_UNAVAILABLE" | "SELLER_UNAVAILABLE",
  ): Promise<SafeFetchResponse> {
    try {
      return await this.#fetch(url, options)
    } catch (error) {
      if (error instanceof SafeFetchError && error.code === "REQUEST_ABORTED") {
        throw new OwnedSellerClientError("REQUEST_ABORTED", "owned seller request was aborted", true)
      }
      throw new OwnedSellerClientError(code, "owned seller request did not complete", true)
    }
  }
}

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"

const parseJson = (body: Uint8Array): unknown => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const stringifyJson = (value: unknown): string => {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError("not serializable")
    return encoded
  } catch {
    throw new OwnedSellerClientError("INVALID_REQUEST", "owned seller negotiation request is invalid", false)
  }
}

const elapsed = (started: number, finished: number): number => Math.max(0, finished - started)

const sha256 = (value: Uint8Array): `0x${string}` =>
  `0x${createHash("sha256").update(value).digest("hex")}`
