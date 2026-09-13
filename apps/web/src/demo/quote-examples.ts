import { keccak256 } from "viem"
import type { AgentSlug } from "../agent-catalog.ts"
import retainedExamples from "./retained-examples.json" with { type: "json" }
import { rangePilotRequestTemplate, rangePilotTaskTemplate } from "./rangepilot-example.ts"

export type DemoAgentSlug = AgentSlug

export type DemoQuoteOptions = {
  agentSlug: DemoAgentSlug
  targetRangeWidthTicks?: 600 | 1200 | 2400
  maximumSlippageBps?: 25 | 50 | 75
}

export type DemoQuoteExample = {
  taskId: string
  serviceRequestId: string
  task: Record<string, unknown>
  requestBytes: Buffer
  requestSchemaVersion: string
  transport: "base64url" | "deflate-base64url"
  sellerOrigin: string
  agentName: string
  categoryLabel: string
  snapshotBlock: string
  snapshotObservedAt: string
  bindings: Array<{ label: string; value: string }>
}

const definitions = {
  healthguard: {
    name: "HealthGuard",
    origin: "https://knot-health.truematchx.com",
    categoryLabel: "Lending health",
    schemaVersion: "knot.health.request/1",
    transport: "base64url" as const,
    task: retainedExamples.healthguard.task,
    request: retainedExamples.healthguard.request,
  },
  rangepilot: {
    name: "RangePilot",
    origin: "https://knot-range.truematchx.com",
    categoryLabel: "LP range analysis",
    schemaVersion: "knot.rangepilot.request/1",
    transport: "deflate-base64url" as const,
    task: rangePilotTaskTemplate,
    request: rangePilotRequestTemplate,
  },
  gridquant: {
    name: "GridQuant",
    origin: "https://knot-grid.truematchx.com",
    categoryLabel: "Grid design",
    schemaVersion: "knot.gridquant.request/2",
    transport: "deflate-base64url" as const,
    task: retainedExamples.gridquant.task,
    request: retainedExamples.gridquant.request,
  },
  yieldscout: {
    name: "YieldScout",
    origin: "https://knot-yield.truematchx.com",
    categoryLabel: "Yield comparison",
    schemaVersion: "knot.yield.request/2",
    transport: "deflate-base64url" as const,
    task: retainedExamples.yieldscout.task,
    request: retainedExamples.yieldscout.request,
  },
} as const

const clone = <T>(value: T): T => structuredClone(value)
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

export function buildDemoQuoteExample(
  options: DemoQuoteOptions,
  now = new Date(),
): DemoQuoteExample {
  const definition = definitions[options.agentSlug]
  const windowNumber = Math.floor(now.getTime() / (5 * 60_000))
  const variant = options.agentSlug === "rangepilot"
    ? `-${options.targetRangeWidthTicks}-${options.maximumSlippageBps}`
    : ""
  const taskId = `web-${options.agentSlug}-${windowNumber.toString(36)}${variant}`
  const serviceRequestId = `web-${options.agentSlug}-quote-${windowNumber.toString(36)}${variant}`
  const deadlineUtc = new Date(windowNumber * 5 * 60_000 + 30 * 60_000).toISOString()
  const task = record(clone(definition.task))
  const sellerRequest = record(clone(definition.request))

  task.taskId = taskId
  task.deadlineUtc = deadlineUtc

  if (options.agentSlug === "healthguard") {
    sellerRequest.task = task
  } else if (options.agentSlug === "rangepilot") {
    const internalTask = record(sellerRequest.task)
    const internalConstraints = record(internalTask.constraints)
    const externalConstraints = record(task.constraints)
    internalTask.taskId = taskId
    internalConstraints.targetRangeWidthTicks = options.targetRangeWidthTicks
    internalConstraints.maximumSlippageBps = options.maximumSlippageBps
    externalConstraints.targetRangeWidthTicks = options.targetRangeWidthTicks
    externalConstraints.maximumSlippageBps = options.maximumSlippageBps
  } else if (options.agentSlug === "gridquant") {
    const internalTask = record(sellerRequest.task)
    const parameters = record(internalTask.parameters)
    const constraints = record(task.constraints)
    internalTask.taskId = taskId
    parameters.expiryUtc = deadlineUtc
    constraints.expiryUtc = deadlineUtc
  } else {
    sellerRequest.taskId = taskId
  }

  const requestBytes = Buffer.from(JSON.stringify(sellerRequest), "utf8")
  if (options.agentSlug !== "healthguard") task.inputHash = keccak256(requestBytes)

  const snapshot = record(sellerRequest.snapshot)
  const bindings = bindingsFor(options, sellerRequest)

  return {
    taskId,
    serviceRequestId,
    task,
    requestBytes,
    requestSchemaVersion: definition.schemaVersion,
    transport: definition.transport,
    sellerOrigin: definition.origin,
    agentName: definition.name,
    categoryLabel: definition.categoryLabel,
    snapshotBlock: String(snapshot.blockNumber ?? "Unavailable"),
    snapshotObservedAt: String(snapshot.capturedAtUtc ?? "Unavailable"),
    bindings,
  }
}

function bindingsFor(options: DemoQuoteOptions, request: Record<string, unknown>) {
  if (options.agentSlug === "rangepilot") {
    return [
      { label: "Range width", value: `${options.targetRangeWidthTicks?.toLocaleString()} ticks` },
      { label: "Slippage limit", value: `${((options.maximumSlippageBps ?? 0) / 100).toFixed(2)}%` },
    ]
  }
  if (options.agentSlug === "healthguard") {
    const task = record(request.task)
    return [
      { label: "Protocol", value: "Venus Core" },
      { label: "Mode", value: String(record(task.constraints).mode ?? "notify") },
    ]
  }
  if (options.agentSlug === "gridquant") {
    const parameters = record(record(request.task).parameters)
    return [
      { label: "Market", value: "WBNB / USDT" },
      { label: "Grid levels", value: String(parameters.gridCount ?? "Unavailable") },
    ]
  }
  return [
    { label: "Asset", value: String(record(request.asset).symbol ?? "USDT") },
    { label: "Markets", value: "Venus · Aave V3" },
  ]
}
