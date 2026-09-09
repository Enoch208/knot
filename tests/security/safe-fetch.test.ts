import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { z } from "zod"
import {
  SafeFetchError,
  safeFetch,
  type ResolvedAddress,
  type SafeFetchTransport,
  type SafeResolver,
} from "../../packages/security/src/index.ts"

const address = z.object({ address: z.string().min(1), family: z.union([z.literal(4), z.literal(6)]) }).strict()
const response = z.object({
  url: z.url(),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  bodyUtf8: z.string(),
}).strict()
const fixtureSet = z.object({
  schemaVersion: z.literal("knot.security.safe-fetch-cases/1"),
  evidenceClass: z.literal("synthetic_fixture"),
  requirementId: z.literal("AT-27"),
  scope: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    url: z.url(),
    dns: z.record(z.string(), z.array(address)),
    responses: z.array(response),
    maxBytes: z.number().int().positive(),
    maxRedirects: z.number().int().nonnegative(),
    expected: z.object({
      outcome: z.enum(["ALLOW", "DENY"]),
      code: z.string().nullable(),
    }).strict(),
  }).strict()).min(1),
  limitations: z.array(z.string().min(1)).min(1),
}).strict()

const fixtures = fixtureSet.parse(JSON.parse(readFileSync("evidence/security/safe-fetch-cases.json", "utf8")) as unknown)

test("frozen outbound-network controls reproduce their expected decisions", async () => {
  for (const fixture of fixtures.cases) {
    const calls: Array<{ url: string; address: ResolvedAddress }> = []
    const resolver: SafeResolver = async (hostname) => fixture.dns[hostname] ?? []
    const transport: SafeFetchTransport = async (request) => {
      calls.push({ url: request.url.href, address: request.address })
      const observed = fixture.responses.find((item) => item.url === request.url.href)
      if (!observed) throw new Error("fixture transport was called without a response")
      return {
        status: observed.status,
        headers: observed.headers,
        body: Buffer.from(observed.bodyUtf8),
      }
    }
    try {
      const result = await safeFetch(fixture.url, {
        resolver,
        transport,
        maxBytes: fixture.maxBytes,
        maxRedirects: fixture.maxRedirects,
      })
      assert.equal(fixture.expected.outcome, "ALLOW", fixture.id)
      assert.equal(fixture.expected.code, null, fixture.id)
      assert.equal(result.status, 200, fixture.id)
    } catch (error) {
      assert.equal(fixture.expected.outcome, "DENY", fixture.id)
      assert.ok(error instanceof SafeFetchError, fixture.id)
      assert.equal(error.code, fixture.expected.code, fixture.id)
    }
    if (fixture.id === "public-dns-pinned") {
      assert.deepEqual(calls, [{
        url: "https://agent.example/.well-known/agent-card.json",
        address: { address: "93.184.216.34", family: 4 },
      }])
    }
  }
})

test("local names, private IPv6, and unsafe ports fail before transport", async () => {
  let calls = 0
  const transport: SafeFetchTransport = async () => {
    calls += 1
    throw new Error("transport must not be reached")
  }
  const cases = [
    ["https://localhost/card", "PRIVATE_HOSTNAME"],
    ["https://service.internal/card", "PRIVATE_HOSTNAME"],
    ["https://[::1]/card", "NON_PUBLIC_ADDRESS"],
    ["https://agent.example:8443/card", "UNSAFE_PORT"],
  ] as const
  for (const [url, code] of cases) {
    await assert.rejects(safeFetch(url, { transport }), (error) => error instanceof SafeFetchError && error.code === code)
  }
  assert.equal(calls, 0)
})

test("every redirect is independently resolved and pinned", async () => {
  const resolved: string[] = []
  const calls: Array<{ host: string; address: string; method: string }> = []
  const resolver: SafeResolver = async (hostname) => {
    resolved.push(hostname)
    return hostname === "first.example"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "104.16.0.1", family: 4 }]
  }
  const transport: SafeFetchTransport = async (request) => {
    calls.push({ host: request.url.hostname, address: request.address.address, method: request.method })
    return request.url.hostname === "first.example"
      ? { status: 303, headers: { location: "https://second.example/result" }, body: new Uint8Array() }
      : { status: 200, headers: {}, body: Buffer.from("ok") }
  }
  const result = await safeFetch("https://first.example/start", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
    resolver,
    transport,
  })
  assert.deepEqual(resolved, ["first.example", "second.example"])
  assert.deepEqual(calls, [
    { host: "first.example", address: "93.184.216.34", method: "POST" },
    { host: "second.example", address: "104.16.0.1", method: "GET" },
  ])
  assert.equal(result.url, "https://second.example/result")
  assert.deepEqual(result.redirects, ["https://second.example/result"])
})

test("a body-preserving redirect cannot move a request to another origin", async () => {
  const resolver: SafeResolver = async (hostname) => hostname === "first.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "104.16.0.1", family: 4 }]
  const transport: SafeFetchTransport = async () => ({
    status: 307,
    headers: { Location: "https://second.example/result" },
    body: new Uint8Array(),
  })
  await assert.rejects(
    safeFetch("https://first.example/start", {
      method: "POST",
      body: "sensitive-task",
      resolver,
      transport,
    }),
    (error) => error instanceof SafeFetchError && error.code === "UNSAFE_REDIRECT",
  )
})

test("an api key is accepted for one origin but cannot cross an origin redirect", async () => {
  const calls: Array<{ host: string; apiKey: string | undefined }> = []
  const resolver: SafeResolver = async () => [{ address: "93.184.216.34", family: 4 }]
  const transport: SafeFetchTransport = async (request) => {
    calls.push({ host: request.url.hostname, apiKey: request.headers["x-api-key"] })
    return {
      status: 302,
      headers: { location: "https://second.example/result" },
      body: new Uint8Array(),
    }
  }
  await assert.rejects(
    safeFetch("https://first.example/start", {
      headers: { "x-api-key": "secret-key-value" },
      resolver,
      transport,
    }),
    (error) => error instanceof SafeFetchError && error.code === "UNSAFE_REDIRECT",
  )
  assert.deepEqual(calls, [{ host: "first.example", apiKey: "secret-key-value" }])
})

test("authorization is accepted for one origin but cannot cross any origin redirect", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls: Array<{ host: string; authorization: string | undefined }> = []
    const resolver: SafeResolver = async () => [{ address: "93.184.216.34", family: 4 }]
    const transport: SafeFetchTransport = async (request) => {
      calls.push({ host: request.url.hostname, authorization: request.headers.authorization })
      return {
        status,
        headers: { location: "https://second.example/result" },
        body: new Uint8Array(),
      }
    }
    await assert.rejects(
      safeFetch("https://first.example/start", {
        headers: { authorization: "Bearer secret-token" },
        resolver,
        transport,
      }),
      (error) => error instanceof SafeFetchError && error.code === "UNSAFE_REDIRECT",
    )
    assert.deepEqual(calls, [{ host: "first.example", authorization: "Bearer secret-token" }])
  }
})

test("the total deadline includes hostname resolution", async () => {
  let transportCalls = 0
  const resolver: SafeResolver = async () => await new Promise((resolve) => {
    setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 150)
  })
  const transport: SafeFetchTransport = async () => {
    transportCalls += 1
    return { status: 200, headers: {}, body: new Uint8Array() }
  }
  await assert.rejects(
    safeFetch("https://agent.example/card", { timeoutMs: 100, resolver, transport }),
    (error) => error instanceof SafeFetchError && error.code === "UPSTREAM_TIMEOUT",
  )
  assert.equal(transportCalls, 0)
})

test("the total deadline bounds a slow transport even when it keeps making progress", async () => {
  const resolver: SafeResolver = async () => [{ address: "93.184.216.34", family: 4 }]
  const transport: SafeFetchTransport = async () => await new Promise((resolve) => {
    setTimeout(() => resolve({ status: 200, headers: {}, body: Buffer.from("late") }), 150)
  })
  await assert.rejects(
    safeFetch("https://agent.example/card", { timeoutMs: 100, resolver, transport }),
    (error) => error instanceof SafeFetchError && error.code === "UPSTREAM_TIMEOUT",
  )
})

test("an abort signal bounds the caller even when transport work is still pending", async () => {
  const resolver: SafeResolver = async () => [{ address: "93.184.216.34", family: 4 }]
  const transport: SafeFetchTransport = async () => await new Promise(() => undefined)
  const controller = new AbortController()
  const pending = safeFetch("https://agent.example/card", {
    timeoutMs: 10_000,
    resolver,
    transport,
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error instanceof SafeFetchError && error.code === "REQUEST_ABORTED",
  )
  await assert.rejects(
    safeFetch("https://agent.example/card", { resolver, transport, signal: controller.signal }),
    (error) => error instanceof SafeFetchError && error.code === "REQUEST_ABORTED",
  )
})

test("redirects share one total deadline instead of resetting it", async () => {
  const observedTimeouts: number[] = []
  const resolver: SafeResolver = async () => [{ address: "93.184.216.34", family: 4 }]
  const transport: SafeFetchTransport = async (request) => await new Promise((resolve) => {
    observedTimeouts.push(request.timeoutMs)
    setTimeout(() => resolve(request.url.hostname === "first.example"
      ? { status: 302, headers: { location: "https://second.example/result" }, body: new Uint8Array() }
      : { status: 200, headers: {}, body: Buffer.from("late") }), 100)
  })
  await assert.rejects(
    safeFetch("https://first.example/start", { timeoutMs: 160, resolver, transport }),
    (error) => error instanceof SafeFetchError && error.code === "UPSTREAM_TIMEOUT",
  )
  assert.equal(observedTimeouts.length, 2)
  assert.ok(observedTimeouts[1]! < observedTimeouts[0]!)
})

test("fixture evidence is closed and discloses the integration boundary", () => {
  assert.equal(new Set(fixtures.cases.map((value) => value.id)).size, fixtures.cases.length)
  assert.equal(fixtures.cases.length, 7)
  assert.match(fixtures.limitations.join(" "), /call sites that use the safe fetch boundary/)
  const changed = JSON.parse(readFileSync("evidence/security/safe-fetch-cases.json", "utf8")) as Record<string, unknown>
  changed.passed = 6
  assert.equal(fixtureSet.safeParse(changed).success, false)
})
