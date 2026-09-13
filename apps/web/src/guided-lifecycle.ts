import type { JobRecord } from "./job-records.ts"

export const guidedJobIds = {
  healthguard: "1181",
  rangepilot: "1189",
  gridquant: "1187",
  yieldscout: "1188",
  refund: "1203",
} as const

export type GuidedJobKey = keyof typeof guidedJobIds

export interface GuidedLifecycleStage {
  id: "funding" | "work" | "artifact" | "resolution"
  label: string
  state: "recorded" | "unavailable" | "refunded"
  summary: string
  detail: string
  transactionLabel: string | null
  transactionUrl: string | null
}

export interface GuidedLifecycle {
  jobId: string
  agentName: string
  operator: string
  recordedAtUtc: string
  terminalLabel: string
  terminalTone: "settled" | "refunded" | "failed" | "unknown"
  stages: readonly GuidedLifecycleStage[]
}

const transactionFor = (job: JobRecord, steps: readonly string[]) =>
  job.transactions.find((transaction) => steps.includes(transaction.step)) ?? null

const outcomes = {
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

const outcomeOf = (job: JobRecord) =>
  Object.hasOwn(outcomes, job.settlement.classification)
    ? outcomes[job.settlement.classification as keyof typeof outcomes]
    : null

const operatorLabelOf = (job: JobRecord): string => {
  if (job.agent.operatorRelationship === "knot_operated") return "KNOT-operated seller"
  if (job.agent.operatorRelationship === "external_distinct_owner") return "Third party, distinct registry owner"
  return job.agent.operatorRelationship
}

const explorerUrl = (job: JobRecord, hash: string): string | null =>
  job.network.explorerTxBaseUrl === null ? null : `${job.network.explorerTxBaseUrl}${hash}`

const transactionFields = (job: JobRecord, steps: readonly string[]) => {
  const transaction = transactionFor(job, steps)
  return {
    transactionLabel: transaction?.label ?? null,
    transactionUrl: transaction === null ? null : explorerUrl(job, transaction.hash),
  }
}

export function buildGuidedLifecycle(job: JobRecord): GuidedLifecycle {
  const outcome = outcomeOf(job)
  const funding = transactionFor(job, ["fund"])
  const submission = transactionFor(job, ["submit"])
  const resolution = transactionFor(job, ["settle", "claimRefund", "refund", "markExpired"])
  const artifactRecorded =
    job.work.deliverySubmitted &&
    job.work.deliverableUrl !== null &&
    job.work.deliverableSha256 !== null &&
    job.work.deliverableManifestHash !== null

  return {
    jobId: job.jobId,
    agentName: job.agent.name ?? `Agent ${job.agent.agentId}`,
    operator: operatorLabelOf(job),
    recordedAtUtc: job.recordedAtUtc,
    terminalLabel: outcome?.label ?? job.settlement.terminalState,
    terminalTone: outcome?.tone ?? "unknown",
    stages: [
      {
        id: "funding",
        label: "FUNDED",
        state: funding?.receiptStatus === "success" ? "recorded" : "unavailable",
        summary: funding?.receiptStatus === "success" ? `${job.money.escrowDisplay ?? "Amount unavailable"} escrowed` : "Funding record unavailable",
        detail: funding === null
          ? "The retained record does not include a funding transaction."
          : `Receipt ${funding.receiptStatus} at block ${funding.blockNumber}.`,
        ...transactionFields(job, ["fund"]),
      },
      {
        id: "work",
        label: "SUBMITTED",
        state: job.work.deliverySubmitted ? "recorded" : "unavailable",
        summary: job.work.deliverySubmitted ? "Delivery submitted" : "No delivery submitted",
        detail: submission === null
          ? "No seller submission transaction exists in this retained record."
          : `The seller submission has a ${submission.receiptStatus} receipt at block ${submission.blockNumber}.`,
        ...transactionFields(job, ["submit"]),
      },
      {
        id: "artifact",
        label: artifactRecorded ? "VERIFIED ARTIFACT" : "ARTIFACT UNAVAILABLE",
        state: artifactRecorded ? "recorded" : "unavailable",
        summary: artifactRecorded ? (job.work.artifactStatus ?? "Artifact retained") : "No artifact available",
        detail: artifactRecorded
          ? `Retained bytes use SHA-256 ${job.work.deliverableSha256}; the recorded manifest binding is ${job.work.deliverableManifestHash}.`
          : "No deliverable bytes were available to verify for this job.",
        transactionLabel: artifactRecorded ? "Open retained artifact" : null,
        transactionUrl: artifactRecorded ? job.work.deliverableUrl : null,
      },
      {
        id: "resolution",
        label: outcome?.tone === "settled" ? "COMPLETED" : outcome?.tone === "refunded" || outcome?.tone === "failed" ? "REFUNDED" : "TERMINAL STATE",
        state: outcome?.tone === "settled" ? "recorded" : outcome?.tone === "refunded" || outcome?.tone === "failed" ? "refunded" : "unavailable",
        summary: outcome?.label ?? job.settlement.terminalState,
        detail: outcome?.money ?? "The retained record has no recognised settlement classification.",
        transactionLabel: resolution?.label ?? null,
        transactionUrl: resolution === null ? null : explorerUrl(job, resolution.hash),
      },
    ],
  }
}
