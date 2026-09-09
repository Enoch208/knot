import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { inflateRawSync } from "node:zlib"
import { gridQuantEvaluationInput } from "../../packages/advantage/src/gridquant-schemas.ts"
import { healthGuardEvaluationInput } from "../../packages/advantage/src/healthguard.ts"
import { rangePilotEvaluationInput } from "../../packages/advantage/src/rangepilot-schemas.ts"
import { yieldScoutEvaluationInput } from "../../packages/advantage/src/yieldscout-schemas.ts"

const compressedPrefix = "knot-json-deflate-base64url/1:"
const base64Prefix = "knot-json-base64url/1:"

interface Observation {
  request: { params: { message: { parts: Array<{ data: { task_description: string } }> } } }
  response: { result: { parts: Array<{ data: { request: { task_description: string } } }> } }
}

interface SignedDescription {
  task: string
}

interface RuntimeSchema {
  safeParse(value: unknown): { success: boolean }
}

type RuntimeFunction = (...args: unknown[]) => unknown

const moduleAt = async (path: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(path).href) as Promise<Record<string, unknown>>

const callable = (module: Record<string, unknown>, name: string): RuntimeFunction => {
  const value = module[name]
  assert.equal(typeof value, "function")
  return value as RuntimeFunction
}

const schema = (module: Record<string, unknown>, name: string): RuntimeSchema => {
  const value = module[name]
  assert.equal(typeof value, "object")
  assert.notEqual(value, null)
  assert.equal(typeof (value as { safeParse?: unknown }).safeParse, "function")
  return value as RuntimeSchema
}

const retainedObservationTask = async (path: string): Promise<string> => {
  const value = JSON.parse(await readFile(path, "utf8")) as Observation
  const request = value.request.params.message.parts[0]?.data.task_description
  const signed = value.response.result.parts[0]?.data.request.task_description
  if (typeof request !== "string") throw new TypeError("retained request is absent")
  assert.equal(signed, request)
  return request
}

const retainedDescriptionTask = async (path: string): Promise<string> => {
  const value = JSON.parse(await readFile(path, "utf8")) as SignedDescription
  assert.equal(typeof value.task, "string")
  return value.task
}

const decode = (taskDescription: string): Buffer => {
  if (taskDescription.startsWith(compressedPrefix)) {
    return inflateRawSync(Buffer.from(taskDescription.slice(compressedPrefix.length), "base64url"))
  }
  assert.ok(taskDescription.startsWith(base64Prefix))
  return Buffer.from(taskDescription.slice(base64Prefix.length), "base64url")
}

const cases = [
  {
    name: "HealthGuard 1185 replay",
    agent: "healthguard",
    directory: "healthguard-1185",
    retained: false,
    analyzerFile: "healthGuard.ts",
    schemaFile: "healthSchemas.ts",
    analyzerExport: "analyzeHealthGuardText",
    encoderExport: "encodeSignedTaskTransport",
    requestSchemaExport: "healthGuardRequest",
    artifactSchemaExport: "healthGuardArtifact",
    source: "generated",
  },
  {
    name: "RangePilot 1189 paid request",
    agent: "rangepilot",
    directory: "rangepilot-1189",
    retained: true,
    analyzerFile: "rangePilot.ts",
    schemaFile: "rangeSchemas.ts",
    analyzerExport: "analyzeRangePilotText",
    encoderExport: "encodeCompressedSignedTaskTransport",
    requestSchemaExport: "rangePilotRequest",
    artifactSchemaExport: "rangePilotArtifact",
    source: "description",
  },
  {
    name: "GridQuant 1187 paid request",
    agent: "gridquant",
    directory: "gridquant-1187",
    retained: true,
    analyzerFile: "gridQuant.ts",
    schemaFile: "gridSchemas.ts",
    analyzerExport: "analyzeGridQuantText",
    encoderExport: "encodeCompressedSignedTaskTransport",
    requestSchemaExport: "gridQuantRequest",
    artifactSchemaExport: "gridQuantArtifact",
    source: "observation",
  },
  {
    name: "YieldScout 1188 paid request",
    agent: "yieldscout",
    directory: "yieldscout-1188",
    retained: true,
    analyzerFile: "yieldScout.ts",
    schemaFile: "yieldSchemas.ts",
    analyzerExport: "analyzeYieldScoutText",
    encoderExport: "encodeCompressedSignedTaskTransport",
    requestSchemaExport: "yieldScoutRequest",
    artifactSchemaExport: "yieldScoutArtifact",
    source: "observation",
  },
] as const

const marketplaceSchemas: Record<(typeof cases)[number]["agent"], RuntimeSchema> = {
  healthguard: healthGuardEvaluationInput,
  rangepilot: rangePilotEvaluationInput,
  gridquant: gridQuantEvaluationInput,
  yieldscout: yieldScoutEvaluationInput,
}

const runtime = async (entry: (typeof cases)[number]) => {
  const root = resolve("agents", entry.agent, "app", "agent", "src")
  const [analyzerModule, schemaModule] = await Promise.all([
    moduleAt(resolve(root, entry.analyzerFile)),
    moduleAt(resolve(root, entry.schemaFile)),
  ])
  return {
    analyze: callable(analyzerModule, entry.analyzerExport),
    encode: callable(analyzerModule, entry.encoderExport),
    requestSchema: schema(schemaModule, entry.requestSchemaExport),
    artifactSchema: schema(schemaModule, entry.artifactSchemaExport),
  }
}

const taskDescription = async (entry: (typeof cases)[number], bytes: Buffer, encode: RuntimeFunction): Promise<string> => {
  if (entry.source === "description") {
    return retainedDescriptionTask("evidence/advantage/rangepilot-1189/signed-job-description.json")
  }
  if (entry.source === "observation") {
    return retainedObservationTask(`evidence/advantage/${entry.directory}/agent-negotiate-observation.json`)
  }
  return String(encode(bytes.toString("utf8")))
}

for (const entry of cases) {
  test(`${entry.name} marketplace schema matches the declared production compatibility matrix`, async () => {
    const request = JSON.parse(await readFile(`evidence/advantage/${entry.directory}/input.json`, "utf8")) as Record<string, unknown>
    const withoutMaximumAge = structuredClone(request)
    delete withoutMaximumAge.maxSnapshotAgeSeconds
    const withUnknownField = { ...structuredClone(request), unexpected: true }
    const withOffsetTimestamp = structuredClone(request) as { snapshot: { capturedAtUtc: string } }
    withOffsetTimestamp.snapshot.capturedAtUtc = "2026-09-09T12:00:00+01:00"
    const candidates: unknown[] = [request, withoutMaximumAge, withUnknownField, withOffsetTimestamp]
    if (entry.agent === "healthguard") {
      const testnet = structuredClone(request) as {
        task: { identityChainId: number; dataChainId: number; paymentChainId: number }
        snapshot: { chainId: number }
      }
      testnet.task.identityChainId = 97
      testnet.task.dataChainId = 97
      testnet.task.paymentChainId = 97
      testnet.snapshot.chainId = 97
      const nullSnapshot = structuredClone(request) as { task: { snapshotId: string | null } }
      nullSnapshot.task.snapshotId = null
      candidates.push(testnet, nullSnapshot)
    }
    const seller = await runtime(entry)
    const marketplace = marketplaceSchemas[entry.agent]
    for (const candidate of candidates) {
      assert.equal(
        marketplace.safeParse(candidate).success,
        seller.requestSchema.safeParse(candidate).success,
      )
    }
  })

  test(`${entry.name} crosses the production seller boundary byte-for-byte`, async () => {
    const root = `evidence/advantage/${entry.directory}`
    const inputBytes = await readFile(`${root}/input.json`)
    const retainedArtifact = JSON.parse(await readFile(`${root}/agent-artifact.json`, "utf8")) as { assessedAtUtc: string; status: string }
    const seller = await runtime(entry)
    const description = await taskDescription(entry, inputBytes, seller.encode)
    assert.deepEqual(decode(description), inputBytes)
    const request = JSON.parse(inputBytes.toString("utf8")) as unknown
    assert.equal(seller.requestSchema.safeParse(request).success, true)
    const artifact = JSON.parse(String(seller.analyze(description, new Date(retainedArtifact.assessedAtUtc)))) as { status: string }
    assert.equal(seller.artifactSchema.safeParse(artifact).success, true)
    assert.deepEqual(artifact, retainedArtifact)
    assert.notEqual(artifact.status, "INVALID_REQUEST")
    if (entry.retained) assert.ok(description.startsWith(compressedPrefix))
  })

  test(`${entry.name} fails closed when the exact closed request gains a field`, async () => {
    const root = `evidence/advantage/${entry.directory}`
    const request = JSON.parse(await readFile(`${root}/input.json`, "utf8")) as Record<string, unknown>
    const seller = await runtime(entry)
    const invalid = String(seller.encode(JSON.stringify({ ...request, unexpected: true })))
    const artifact = JSON.parse(String(seller.analyze(invalid, new Date()))) as { status: string; reasonCode: string | null }
    assert.equal(artifact.status, "INVALID_REQUEST")
    assert.equal(artifact.reasonCode, "SCHEMA_VALIDATION_FAILED")
  })
}
