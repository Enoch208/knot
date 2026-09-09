import { randomUUID } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createDatabasePool } from "../../../packages/db/src/index.ts"
import { createApiHandler } from "./app.ts"
import { loadServerConfig } from "./config.ts"
import { PgApiStore } from "./pg-store.ts"
import type { ApiRequest, ApiResponse } from "./types.ts"

const headerValue = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

const readBody = async (request: IncomingMessage, limit: number): Promise<string | null> => {
  if (request.method === "GET" || request.method === "HEAD") return null
  const chunks: Buffer[] = []
  let bytes = 0
  let exceeded = false
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > limit) {
      exceeded = true
    } else if (!exceeded) {
      chunks.push(chunk)
    }
  }
  return exceeded ? "x".repeat(limit + 1) : Buffer.concat(chunks).toString("utf8")
}

const requestHeaders = (headers: IncomingHttpHeaders): ApiRequest["headers"] => ({
  authorization: headerValue(headers, "authorization"),
  "content-type": headerValue(headers, "content-type"),
  "idempotency-key": headerValue(headers, "idempotency-key"),
  origin: headerValue(headers, "origin"),
  "x-correlation-id": headerValue(headers, "x-correlation-id"),
})

const writeResponse = (target: ServerResponse, response: ApiResponse): void => {
  target.writeHead(response.status, response.headers)
  target.end(response.body)
}

const run = async (): Promise<void> => {
  const config = loadServerConfig(process.env)
  const pool = createDatabasePool(config.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  })
  const store = new PgApiStore(pool)
  await store.status()
  const handle = createApiHandler(store, config.api)
  const server = createServer((request, response) => {
    const serve = async (): Promise<void> => {
      const host = request.headers.host ?? `${config.host}:${config.port}`
      let path: string
      try {
        path = new URL(request.url ?? "/", `http://${host}`).pathname
      } catch {
        path = "/invalid-request-url"
      }
      const apiRequest: ApiRequest = {
        method: request.method ?? "GET",
        path,
        headers: requestHeaders(request.headers),
        body: await readBody(request, config.api.maxBodyBytes),
      }
      writeResponse(response, await handle(apiRequest))
    }
    void serve().catch(() => {
      if (response.headersSent || response.destroyed) return
      const correlationId = randomUUID()
      writeResponse(response, {
        status: 400,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-correlation-id": correlationId,
        },
        body: JSON.stringify({
          code: "INVALID_REQUEST",
          explanation: "The HTTP request could not be read.",
          retryable: false,
          correlationId,
          financialState: "unknown",
        }),
      })
    })
  })
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })
  const shutdown = (): void => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0))
    })
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, resolve)
  })
  process.stderr.write(`${JSON.stringify({ service: "knot-api", status: "listening", host: config.host, port: config.port })}\n`)
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup failure"
  process.stderr.write(`${JSON.stringify({ service: "knot-api", status: "failed", message })}\n`)
  process.exitCode = 1
})
