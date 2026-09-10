import snapshot from "./job-records.snapshot.json"

export const UNAVAILABLE = "unavailable"

export interface JobTransaction {
  step: string
  label: string
  hash: string
  receiptStatus: string
  blockNumber: string
  timestampUtc: string | null
}

export interface JobRecord {
  jobId: string
  sourcePath: string
  recordedAtUtc: string
  agent: {
    agentId: string
    name: string | null
    category: string | null
    capability: string | null
    operatorRelationship: string
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
    classification: string
    disputed: boolean
    settlementTransactionHash: string | null
    refundTransactionHash: string | null
  }
  transactions: readonly JobTransaction[]
  limitations: readonly string[]
}

export interface JobRecordsSnapshot {
  schemaVersion: string
  observationsThroughUtc: string
  sources: readonly string[]
  jobs: readonly JobRecord[]
}

export const jobRecordsSnapshot: JobRecordsSnapshot = snapshot

export const jobRecords: readonly JobRecord[] = jobRecordsSnapshot.jobs

const OUTCOME_PRESENTATION = {
  SETTLED_TO_PROVIDER: {
    label: "Settled to provider",
    tone: "settled",
    money: "The escrow was released to the provider.",
  },
  DISPUTED_REFUNDED_TO_BUYER: {
    label: "Disputed, refunded to buyer",
    tone: "refunded",
    money: "The buyer disputed the submitted work and the escrow was returned in full.",
  },
  EXPIRED_WITHOUT_DELIVERY: {
    label: "Expired without delivery",
    tone: "failed",
    money: "Nothing was delivered before expiry and the escrow was returned in full.",
  },
} as const

type OutcomeKey = keyof typeof OUTCOME_PRESENTATION

export type OutcomePresentation = (typeof OUTCOME_PRESENTATION)[OutcomeKey]

const isOutcomeKey = (value: string): value is OutcomeKey => Object.hasOwn(OUTCOME_PRESENTATION, value)

export const outcomeOf = (job: JobRecord): OutcomePresentation | null =>
  isOutcomeKey(job.settlement.classification) ? OUTCOME_PRESENTATION[job.settlement.classification] : null

const OPERATOR_LABELS: Readonly<Record<string, string>> = {
  knot_operated: "KNOT-operated seller",
  external_distinct_owner: "Third party, distinct registry owner",
}

export const operatorLabelOf = (job: JobRecord): string =>
  OPERATOR_LABELS[job.agent.operatorRelationship] ?? job.agent.operatorRelationship

export const explorerUrl = (job: JobRecord, hash: string): string | null =>
  job.network.explorerTxBaseUrl === null ? null : `${job.network.explorerTxBaseUrl}${hash}`

export const findJobRecord = (jobId: string): JobRecord | null =>
  jobRecords.find((job) => job.jobId === jobId) ?? null

export interface JobRecordsTally {
  total: number
  settled: number
  refunded: number
  expiredWithoutDelivery: number
  providerReceivedDisplay: string | null
  buyerRefundedDisplay: string | null
}

const sumBaseUnits = (amounts: readonly (string | null)[]): bigint =>
  amounts.reduce<bigint>((total, amount) => (amount === null ? total : total + BigInt(amount)), 0n)

const formatBaseUnits = (baseUnits: bigint, decimals: number, symbol: string): string => {
  const digits = baseUnits.toString().padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, "")
  return `${whole}${fraction.length > 0 ? `.${fraction}` : ""} ${symbol}`
}

const singleToken = (jobs: readonly JobRecord[]): { symbol: string; decimals: number } | null => {
  const symbols = new Set(jobs.map((job) => job.money.tokenSymbol))
  const decimals = new Set(jobs.map((job) => job.money.tokenDecimals))
  const symbol = [...symbols][0]
  const decimal = [...decimals][0]
  if (symbols.size !== 1 || decimals.size !== 1) return null
  if (typeof symbol !== "string" || typeof decimal !== "number") return null
  return { symbol, decimals: decimal }
}

export const tallyJobRecords = (jobs: readonly JobRecord[]): JobRecordsTally => {
  const token = singleToken(jobs)
  const display = (amount: bigint): string | null =>
    token === null ? null : formatBaseUnits(amount, token.decimals, token.symbol)
  const counted = (key: OutcomeKey): number =>
    jobs.filter((job) => job.settlement.classification === key).length
  return {
    total: jobs.length,
    settled: counted("SETTLED_TO_PROVIDER"),
    refunded: counted("DISPUTED_REFUNDED_TO_BUYER"),
    expiredWithoutDelivery: counted("EXPIRED_WITHOUT_DELIVERY"),
    providerReceivedDisplay: display(sumBaseUnits(jobs.map((job) => job.money.providerReceivedBaseUnits))),
    buyerRefundedDisplay: display(sumBaseUnits(jobs.map((job) => job.money.buyerRefundedBaseUnits))),
  }
}
