#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const SNAPSHOT_RELATIVE_PATH = "apps/web/src/job-records.snapshot.json"
export const EVIDENCE_RELATIVE_DIRECTORY = "evidence/testnet"
export const SNAPSHOT_SCHEMA_VERSION = "knot.job-records-snapshot/1"

export class JobRecordSourceError extends Error {}

type JsonRecord = { readonly [key: string]: unknown }

interface TransactionRow {
  step: string
  label: string
  hash: string
  receiptStatus: string
  blockNumber: string
  timestampUtc: string | null
}

interface JobRecord {
  jobId: string
  sourcePath: string
  recordedAtUtc: string
  agent: {
    agentId: string
    name: string | null
    category: string | null
    capability: string | null
    operatorRelationship: "knot_operated" | "external_distinct_owner"
  }
  network: { name: string; chainId: number; explorerTxBaseUrl: string | null }
  parties: { buyer: string; provider: string; evaluator: string | null; buyerIsProvider: boolean }
  contracts: { commerce: string | null; paymentToken: string | null; policy: string | null }
  money: {
    tokenSymbol: string | null
    tokenDecimals: number | null
    escrowBaseUnits: string
    escrowDisplay: string | null
    providerReceivedBaseUnits: string
    providerReceivedDisplay: string | null
    buyerRefundedBaseUnits: string | null
    buyerRefundedDisplay: string | null
  }
  work: {
    deliverySubmitted: boolean
    deliverableUrl: string | null
    deliverableSha256: string | null
    deliverableManifestHash: string | null
    artifactStatus: string | null
    artifactReasonCode: string | null
    taskId: string | null
    taskInputHash: string | null
    snapshotId: string | null
    quoteRequestHash: string | null
    negotiationHash: string | null
  }
  settlement: {
    terminalState: string
    classification: "SETTLED_TO_PROVIDER" | "DISPUTED_REFUNDED_TO_BUYER" | "EXPIRED_WITHOUT_DELIVERY"
    disputed: boolean
    settlementTransactionHash: string | null
    refundTransactionHash: string | null
  }
  transactions: TransactionRow[]
  limitations: string[]
}

export interface JobRecordsSnapshot {
  schemaVersion: string
  observationsThroughUtc: string
  sources: string[]
  jobs: JobRecord[]
}

const STEP_LABELS: ReadonlyMap<string, string> = new Map([
  ["create", "Job created"],
  ["register", "Policy registered"],
  ["approve", "Token allowance approved"],
  ["setBudget", "Budget set"],
  ["fund", "Escrow funded"],
  ["submit", "Deliverable submitted"],
  ["dispute", "Buyer disputed"],
  ["settle", "Escrow settled"],
  ["claimRefund", "Escrow refunded"],
  ["refund", "Escrow refunded"],
  ["markExpired", "Marked expired"],
])

const fail = (source: string, detail: string): never => {
  throw new JobRecordSourceError(`${source}: ${detail}`)
}

const pick = (root: JsonRecord, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as JsonRecord)[key]
        : undefined,
    root,
  )

const optionalText = (root: JsonRecord, path: string): string | null => {
  const value = pick(root, path)
  return typeof value === "string" && value.length > 0 ? value : null
}

const text = (root: JsonRecord, path: string, source: string): string =>
  optionalText(root, path) ?? fail(source, `expected a non-empty string at ${path}`)

const wholeNumber = (root: JsonRecord, path: string, source: string): number => {
  const value = pick(root, path)
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fail(source, `expected an integer at ${path}`)
}

const textList = (root: JsonRecord, path: string): string[] => {
  const value = pick(root, path)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null

const meaningfulHash = (root: JsonRecord, path: string): string | null => {
  const value = optionalText(root, path)
  return value === null || /^0x0*$/u.test(value) ? null : value
}

export const formatBaseUnits = (baseUnits: string, decimals: number, symbol: string): string => {
  const digits = baseUnits.padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, "")
  return `${whole}${fraction.length > 0 ? `.${fraction}` : ""} ${symbol}`
}

interface TokenFacts {
  symbol: string | null
  decimals: number | null
}

interface AgentFacts {
  name: string | null
  category: string | null
  capability: string | null
}

interface SourceContext {
  tokens: ReadonlyMap<string, TokenFacts>
  agents: ReadonlyMap<string, AgentFacts>
  explorers: ReadonlyMap<number, string>
}

const money = (
  tokenAddress: string | null,
  context: SourceContext,
  escrow: string,
  providerReceived: string,
  buyerRefunded: string | null,
): JobRecord["money"] => {
  const facts = tokenAddress === null ? undefined : context.tokens.get(tokenAddress.toLowerCase())
  const symbol = facts?.symbol ?? null
  const decimals = facts?.decimals ?? null
  const display = (amount: string | null): string | null =>
    amount === null || symbol === null || decimals === null ? null : formatBaseUnits(amount, decimals, symbol)
  return {
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    escrowBaseUnits: escrow,
    escrowDisplay: display(escrow),
    providerReceivedBaseUnits: providerReceived,
    providerReceivedDisplay: display(providerReceived),
    buyerRefundedBaseUnits: buyerRefunded,
    buyerRefundedDisplay: display(buyerRefunded),
  }
}

const transactions = (container: unknown, source: string): TransactionRow[] => {
  const record = asRecord(container) ?? fail(source, "expected a transactions object")
  const rows = Object.entries(record).map(([step, value]) => {
    const entry = asRecord(value) ?? fail(source, `expected an object at transactions.${step}`)
    return {
      step,
      label: STEP_LABELS.get(step) ?? step,
      hash: text(entry, "hash", source),
      receiptStatus: optionalText(entry, "receiptStatus") ?? text(entry, "status", source),
      blockNumber: text(entry, "blockNumber", source),
      timestampUtc: optionalText(entry, "timestampUtc"),
    }
  })
  return rows.sort((left, right) => (BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1))
}

const readTestnetJob = (root: JsonRecord, source: string, context: SourceContext): JobRecord => {
  const terminalState = text(root, "job.settlementTerminalState", source)
  const disputed = pick(root, "job.disputed") === true
  const refundHash = optionalText(root, "job.refundTransactionHash")
  const settlementHash = optionalText(root, "job.settlementTransactionHash")
  const providerReceived = optionalText(root, "transactions.settle.paymentTransfer.amountBaseUnits") ?? "0"
  const classification =
    terminalState === "COMPLETED" && settlementHash !== null
      ? "SETTLED_TO_PROVIDER"
      : disputed && refundHash !== null
        ? "DISPUTED_REFUNDED_TO_BUYER"
        : fail(source, `unrecognised terminal outcome ${terminalState}`)
  const buyerRefunded =
    optionalText(root, "transactions.claimRefund.refundTransfer.amountBaseUnits") ??
    (classification === "SETTLED_TO_PROVIDER" ? "0" : null)
  const agentId = text(root, "identity.erc8004AgentId", source)
  const chainId = wholeNumber(root, "network.chainId", source)
  const buyer = text(root, "job.buyer", source)
  const provider = text(root, "job.provider", source)
  return {
    jobId: text(root, "job.jobId", source),
    sourcePath: source,
    recordedAtUtc: text(root, "recordedAtUtc", source),
    agent: { agentId, ...agentFacts(context, agentId), operatorRelationship: "knot_operated" },
    network: {
      name: text(root, "network.name", source),
      chainId,
      explorerTxBaseUrl: context.explorers.get(chainId) ?? null,
    },
    parties: {
      buyer,
      provider,
      evaluator: optionalText(root, "contracts.router"),
      buyerIsProvider: buyer.toLowerCase() === provider.toLowerCase(),
    },
    contracts: {
      commerce: optionalText(root, "contracts.commerce"),
      paymentToken: optionalText(root, "contracts.paymentToken"),
      policy: optionalText(root, "contracts.policy"),
    },
    money: money(
      optionalText(root, "contracts.paymentToken"),
      context,
      text(root, "job.budgetBaseUnits", source),
      providerReceived,
      buyerRefunded,
    ),
    work: {
      deliverySubmitted: optionalText(root, "transactions.submit.hash") !== null,
      deliverableUrl: optionalText(root, "deliverable.url"),
      deliverableSha256: optionalText(root, "deliverable.rawSha256"),
      deliverableManifestHash: meaningfulHash(root, "job.onChainDeliverableHash"),
      artifactStatus: optionalText(root, "deliverable.artifact.status"),
      artifactReasonCode: optionalText(root, "deliverable.artifact.reasonCode"),
      taskId: optionalText(root, "signedRequestBinding.taskId"),
      taskInputHash: meaningfulHash(root, "signedRequestBinding.inputHash"),
      snapshotId: meaningfulHash(root, "signedRequestBinding.snapshotId"),
      quoteRequestHash: null,
      negotiationHash: meaningfulHash(root, "job.negotiationHash"),
    },
    settlement: {
      terminalState,
      classification,
      disputed,
      settlementTransactionHash: settlementHash,
      refundTransactionHash: refundHash,
    },
    transactions: transactions(pick(root, "transactions"), source),
    limitations: textList(root, "limitations"),
  }
}

const readAnalysisJob = (
  entry: JsonRecord,
  root: JsonRecord,
  source: string,
  context: SourceContext,
): JobRecord => {
  const terminalState = text(entry, "terminalStatus", source)
  const providerReceived =
    optionalText(entry, "transactions.settle.paymentTransfer.amountBaseUnits") ??
    fail(source, `job ${text(entry, "jobId", source)} records no settlement transfer`)
  if (terminalState !== "COMPLETED") fail(source, `unrecognised terminal outcome ${terminalState}`)
  const agentId = text(entry, "agentId", source)
  const buyer = text(entry, "buyer", source)
  const provider = text(entry, "seller", source)
  const chainId = wholeNumber(entry, "scope.paymentChainId", source)
  const token = optionalText(root, "commerce.paymentToken")
  return {
    jobId: text(entry, "jobId", source),
    sourcePath: source,
    recordedAtUtc: text(root, "recordedAtUtc", source),
    agent: { agentId, ...agentFacts(context, agentId), operatorRelationship: "knot_operated" },
    network: {
      name: text(root, "networkBoundary.identityAndCommerce.name", source),
      chainId,
      explorerTxBaseUrl: context.explorers.get(chainId) ?? null,
    },
    parties: {
      buyer,
      provider,
      evaluator: optionalText(entry, "evaluator"),
      buyerIsProvider: buyer.toLowerCase() === provider.toLowerCase(),
    },
    contracts: {
      commerce: optionalText(root, "commerce.contract"),
      paymentToken: token,
      policy: optionalText(entry, "disputePolicy.address"),
    },
    money: money(token, context, text(entry, "priceBaseUnits", source), providerReceived, "0"),
    work: {
      deliverySubmitted: optionalText(entry, "transactions.submit.hash") !== null,
      deliverableUrl: optionalText(entry, "deliverable.url"),
      deliverableSha256: optionalText(entry, "deliverable.rawSha256"),
      deliverableManifestHash: meaningfulHash(entry, "deliverable.manifestKeccak256"),
      artifactStatus: optionalText(entry, "outcome.status"),
      artifactReasonCode: optionalText(entry, "outcome.reasonCode"),
      taskId: optionalText(entry, "taskBinding.taskId"),
      taskInputHash: meaningfulHash(entry, "taskBinding.inputHash"),
      snapshotId: meaningfulHash(entry, "taskBinding.snapshotId"),
      quoteRequestHash: null,
      negotiationHash: null,
    },
    settlement: {
      terminalState,
      classification: "SETTLED_TO_PROVIDER",
      disputed: false,
      settlementTransactionHash: optionalText(entry, "transactions.settle.hash"),
      refundTransactionHash: null,
    },
    transactions: transactions(pick(entry, "transactions"), source),
    limitations: textList(root, "limitations"),
  }
}

const readExternalJob = (root: JsonRecord, source: string, context: SourceContext): JobRecord => {
  const reason = text(root, "outcome.reason", source)
  if (reason !== "EXPIRED_WITHOUT_DELIVERY") fail(source, `unrecognised failure reason ${reason}`)
  const agentId = text(root, "identity.agentId", source)
  const buyer = text(root, "identity.buyer", source)
  const provider = text(root, "identity.provider", source)
  const chainId = wholeNumber(root, "network.chainId", source)
  const token = optionalText(root, "network.contracts.paymentToken")
  return {
    jobId: text(root, "lifecycle.jobId", source),
    sourcePath: source,
    recordedAtUtc: text(root, "capturedAtUtc", source),
    agent: {
      agentId,
      name: optionalText(root, "identity.name"),
      category: null,
      capability: null,
      operatorRelationship: "external_distinct_owner",
    },
    network: {
      name: text(root, "network.name", source),
      chainId,
      explorerTxBaseUrl: context.explorers.get(chainId) ?? null,
    },
    parties: {
      buyer,
      provider,
      evaluator: optionalText(root, "lifecycle.evaluator"),
      buyerIsProvider: buyer.toLowerCase() === provider.toLowerCase(),
    },
    contracts: {
      commerce: optionalText(root, "network.contracts.commerce"),
      paymentToken: token,
      policy: null,
    },
    money: money(
      token,
      context,
      text(root, "lifecycle.budgetBaseUnits", source),
      text(root, "outcome.providerPaymentBaseUnits", source),
      optionalText(root, "refund.refundedBaseUnits"),
    ),
    work: {
      deliverySubmitted: pick(root, "outcome.deliveryReceived") === true,
      deliverableUrl: optionalText(root, "lifecycle.deliverableUrl"),
      deliverableSha256: null,
      deliverableManifestHash: meaningfulHash(root, "lifecycle.deliverableHash"),
      artifactStatus: null,
      artifactReasonCode: null,
      taskId: null,
      taskInputHash: null,
      snapshotId: null,
      quoteRequestHash: meaningfulHash(root, "quote.request_hash"),
      negotiationHash: meaningfulHash(root, "quote.negotiation_hash"),
    },
    settlement: {
      terminalState: text(root, "lifecycle.terminalStatus", source),
      classification: "EXPIRED_WITHOUT_DELIVERY",
      disputed: pick(root, "lifecycle.disputed") === true,
      settlementTransactionHash: null,
      refundTransactionHash: optionalText(root, "transactions.refund.hash"),
    },
    transactions: transactions(pick(root, "transactions"), source),
    limitations: textList(root, "limitations"),
  }
}

const agentFacts = (context: SourceContext, agentId: string): AgentFacts =>
  context.agents.get(agentId) ?? { name: null, category: null, capability: null }

const collectContext = (documents: ReadonlyMap<string, JsonRecord>): SourceContext => {
  const tokens = new Map<string, TokenFacts>()
  const agents = new Map<string, AgentFacts>()
  const explorers = new Map<number, string>()
  for (const [source, root] of documents) {
    const schema = optionalText(root, "schemaVersion")
    const explorer = optionalText(root, "network.transactionExplorerBaseUrl")
    const chainId = pick(root, "network.chainId")
    if (explorer !== null && typeof chainId === "number") explorers.set(chainId, explorer)
    const token = optionalText(root, "contracts.paymentToken")
    const symbol = optionalText(root, "payment.symbol")
    const decimals = pick(root, "payment.decimals")
    if (token !== null && symbol !== null && typeof decimals === "number") {
      tokens.set(token.toLowerCase(), { symbol, decimals })
    }
    if (schema === "knot.testnet-agent-evidence/1") {
      agents.set(text(root, "identity.agentId", source), {
        name: optionalText(root, "identity.name"),
        category: optionalText(root, "identity.category"),
        capability: optionalText(root, "identity.capability"),
      })
    }
    if (schema === "knot.testnet-analysis-sellers-evidence/1") {
      const sellers = pick(root, "sellers")
      for (const seller of Array.isArray(sellers) ? sellers : []) {
        const entry = asRecord(seller)
        if (entry === null) continue
        agents.set(text(entry, "identity.agentId", source), {
          name: optionalText(entry, "identity.name"),
          category: optionalText(entry, "category"),
          capability: optionalText(entry, "capability"),
        })
      }
    }
  }
  return { tokens, agents, explorers }
}

export const buildJobRecordsSnapshot = (repositoryRoot: string): JobRecordsSnapshot => {
  const directory = resolve(repositoryRoot, EVIDENCE_RELATIVE_DIRECTORY)
  const documents = new Map<string, JsonRecord>()
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const source = `${EVIDENCE_RELATIVE_DIRECTORY}/${name}`
    const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"))
    documents.set(source, asRecord(parsed) ?? fail(source, "expected a JSON object"))
  }
  const context = collectContext(documents)
  const jobs: JobRecord[] = []
  for (const [source, root] of documents) {
    const schema = optionalText(root, "schemaVersion")
    if (schema === "knot.testnet-job-evidence/1") jobs.push(readTestnetJob(root, source, context))
    if (schema === "knot.external-paid-job-failure/1") jobs.push(readExternalJob(root, source, context))
    if (schema === "knot.analysis-paid-jobs-evidence/1") {
      const entries = pick(root, "jobs")
      for (const item of Array.isArray(entries) ? entries : []) {
        const entry = asRecord(item) ?? fail(source, "expected a job object in jobs[]")
        jobs.push(readAnalysisJob(entry, root, source, context))
      }
    }
  }
  if (jobs.length === 0) fail(EVIDENCE_RELATIVE_DIRECTORY, "no job evidence documents were found")
  jobs.sort((left, right) => Number(BigInt(left.jobId) - BigInt(right.jobId)))
  const observations = jobs.map((job) => job.recordedAtUtc).sort()
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    observationsThroughUtc: observations[observations.length - 1] ?? "",
    sources: [...new Set(jobs.map((job) => job.sourcePath))].sort(),
    jobs,
  }
}

export const serialiseJobRecordsSnapshot = (snapshot: JobRecordsSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const repositoryRoot = resolve(import.meta.dirname, "..")
  const snapshot = buildJobRecordsSnapshot(repositoryRoot)
  writeFileSync(resolve(repositoryRoot, SNAPSHOT_RELATIVE_PATH), serialiseJobRecordsSnapshot(snapshot))
  process.stderr.write(`job records snapshot: ${snapshot.jobs.length} jobs -> ${SNAPSHOT_RELATIVE_PATH}\n`)
}
