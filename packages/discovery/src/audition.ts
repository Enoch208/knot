import { z } from "zod"
import { address } from "../../contracts/src/primitives.ts"

const publicHttpsUrl = z.url().refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
}, "source URLs must use HTTPS without embedded credentials")

export const auditionOutcome = z.enum(["VERIFIED", "FAILED", "UNVERIFIED", "NOT_RUN"])
export const auditionStageName = z.enum(["registered", "endpoint_live", "callable", "quote_capable", "hireable"])

const stageObservation = z
  .object({
    outcome: auditionOutcome,
    observedAtUtc: z.iso.datetime(),
    source: z.enum(["8004scan_detail", "agent_card", "readiness", "a2a_message_send", "quote_endpoint", "derived"]),
    sourceUri: publicHttpsUrl,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    detail: z.string().min(1).max(500),
  })
  .strict()

const stages = z
  .object({
    registered: stageObservation,
    endpointLive: stageObservation,
    callable: stageObservation,
    quoteCapable: stageObservation,
    hireable: stageObservation,
  })
  .strict()

const quoteObservation = z
  .object({
    quoteId: z.string().min(1),
    observedAtUtc: z.iso.datetime(),
    expiresAtUnix: z.string().regex(/^[1-9][0-9]*$/),
    ttlSeconds: z.number().int().positive(),
    chainId: z.literal(97),
    environment: z.literal("testnet"),
    priceBaseUnits: z.string().regex(/^[1-9][0-9]*$/),
    currency: address,
    providerAddress: address,
    providerMatchesRegistryOwner: z.boolean(),
    sellerResponseAccepted: z.boolean(),
    taskDescriptionBound: z.boolean(),
    signaturePresent: z.boolean(),
    signatureVerified: z.boolean(),
    domainBindingPresent: z.boolean(),
    acceptedByKnot: z.literal(false),
    jobCreated: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const observedAtUnix = BigInt(Math.floor(new Date(value.observedAtUtc).getTime() / 1_000))
    if (BigInt(value.expiresAtUnix) - observedAtUnix !== BigInt(value.ttlSeconds)) {
      context.addIssue({ code: "custom", path: ["expiresAtUnix"], message: "quote expiry must match the observed TTL" })
    }
    if (value.signatureVerified && !value.signaturePresent) {
      context.addIssue({ code: "custom", path: ["signatureVerified"], message: "an absent quote signature cannot be verified" })
    }
    if (value.domainBindingPresent && !value.signaturePresent) {
      context.addIssue({ code: "custom", path: ["domainBindingPresent"], message: "an unsigned quote cannot carry a verified signature domain" })
    }
  })

const candidate = z
  .object({
    identity: z.object({
      chainId: z.literal(97),
      registry: address,
      agentId: z.string().regex(/^(0|[1-9][0-9]*)$/),
      ownerAddress: address,
      name: z.string().min(1),
      registrationTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).strict(),
    operatorRelationship: z.object({
      status: z.literal("NOT_PROVEN"),
      candidateOwnerDiffersFromKnot: z.literal(true),
      knotOwnerAddress: address,
      basis: z.string().min(1).max(500),
      limitation: z.string().min(1).max(500),
    }).strict(),
    compatibility: z.object({
      category: z.literal("health"),
      inputProvenance: z.enum(["CALLER_ATTESTED", "PINNED_ONCHAIN", "UNVERIFIED"]),
      comparisonToKnotHealthGuard: z.enum(["COMPATIBLE", "PARTIAL", "INCOMPATIBLE", "UNVERIFIED"]),
      endpointDurability: z.enum(["DURABLE", "EPHEMERAL", "UNVERIFIED"]),
      detail: z.string().min(1).max(500),
    }).strict(),
    advertised: z.object({
      protocols: z.array(z.string().min(1)),
      skillIds: z.array(z.string().min(1)),
      quoteAdvertised: z.boolean(),
    }).strict(),
    quoteObservation: quoteObservation.optional(),
    stages,
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identity.ownerAddress.toLowerCase() === value.operatorRelationship.knotOwnerAddress.toLowerCase()) {
      context.addIssue({ code: "custom", path: ["operatorRelationship"], message: "a distinct-owner relationship requires different owner addresses" })
    }
    const ordered = [value.stages.registered, value.stages.endpointLive, value.stages.callable, value.stages.quoteCapable, value.stages.hireable]
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.outcome === "VERIFIED" && ordered[index - 1]!.outcome !== "VERIFIED") {
        context.addIssue({ code: "custom", path: ["stages"], message: "a later audition stage cannot be verified before every earlier stage" })
      }
    }
    if (value.stages.endpointLive.outcome === "VERIFIED" && value.stages.endpointLive.httpStatus !== 200) {
      context.addIssue({ code: "custom", path: ["stages", "endpointLive"], message: "a live endpoint requires HTTP 200" })
    }
    if (value.stages.callable.outcome === "VERIFIED" && value.stages.callable.httpStatus !== 200) {
      context.addIssue({ code: "custom", path: ["stages", "callable"], message: "a callable task requires a successful protocol response" })
    }
    if (value.stages.quoteCapable.outcome === "VERIFIED" && value.stages.quoteCapable.httpStatus !== 200) {
      context.addIssue({ code: "custom", path: ["stages", "quoteCapable"], message: "a verified quote requires a successful quote response" })
    }
    if (value.stages.quoteCapable.outcome === "VERIFIED" && !value.advertised.quoteAdvertised) {
      context.addIssue({ code: "custom", path: ["advertised", "quoteAdvertised"], message: "a verified quote capability must be advertised" })
    }
    if (value.quoteObservation && value.quoteObservation.providerMatchesRegistryOwner !== (value.quoteObservation.providerAddress.toLowerCase() === value.identity.ownerAddress.toLowerCase())) {
      context.addIssue({ code: "custom", path: ["quoteObservation", "providerMatchesRegistryOwner"], message: "quote provider ownership comparison is inconsistent" })
    }
    if (value.stages.quoteCapable.outcome === "VERIFIED") {
      const quote = value.quoteObservation
      if (!quote || !quote.providerMatchesRegistryOwner || !quote.sellerResponseAccepted || !quote.taskDescriptionBound || !quote.signaturePresent || !quote.signatureVerified || !quote.domainBindingPresent) {
        context.addIssue({ code: "custom", path: ["quoteObservation"], message: "a verified quote must be task-bound and cryptographically attributable to the registered provider" })
      }
    }
    if (value.stages.hireable.outcome === "VERIFIED" && value.compatibility.endpointDurability !== "DURABLE") {
      context.addIssue({ code: "custom", path: ["compatibility", "endpointDurability"], message: "a hireable candidate requires a durable endpoint" })
    }
  })

export const thirdPartyAuditionReport = z
  .object({
    schemaVersion: z.literal("knot.discovery.third-party-audition/1"),
    observedAtUtc: z.iso.datetime(),
    scope: z.object({
      chainId: z.literal(97),
      searchTerm: z.literal("health"),
      discoveryRequestUri: publicHttpsUrl,
      returnedCount: z.number().int().nonnegative(),
      matchingTotal: z.number().int().nonnegative(),
      selectionPolicy: z.string().min(1).max(500),
    }).strict(),
    safety: z.object({
      walletSignaturesRequested: z.literal(false),
      paymentsAttempted: z.literal(false),
      chainWritesAttempted: z.literal(false),
      purchasesAttempted: z.literal(false),
    }).strict(),
    candidates: z.array(candidate).min(1),
    summary: z.object({
      registeredCount: z.number().int().nonnegative(),
      endpointLiveCount: z.number().int().nonnegative(),
      callableCount: z.number().int().nonnegative(),
      quoteCapableCount: z.number().int().nonnegative(),
      hireableCount: z.number().int().nonnegative(),
      conclusion: z.string().min(1).max(500),
    }).strict(),
  })
  .strict()

export type ThirdPartyAuditionReport = z.infer<typeof thirdPartyAuditionReport>

export class ThirdPartyAuditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ThirdPartyAuditionError"
  }
}

export function verifyThirdPartyAudition(input: unknown): ThirdPartyAuditionReport {
  const parsed = thirdPartyAuditionReport.safeParse(input)
  if (!parsed.success) throw new ThirdPartyAuditionError("third-party audition evidence does not match the closed schema")
  const report = parsed.data
  const identities = report.candidates.map((item) => `${item.identity.chainId}:${item.identity.registry}:${item.identity.agentId}`)
  if (new Set(identities).size !== identities.length) throw new ThirdPartyAuditionError("third-party audition identities must be unique")
  const counts = {
    registeredCount: count(report, "registered"),
    endpointLiveCount: count(report, "endpoint_live"),
    callableCount: count(report, "callable"),
    quoteCapableCount: count(report, "quote_capable"),
    hireableCount: count(report, "hireable"),
  }
  for (const [key, value] of Object.entries(counts)) {
    if (report.summary[key as keyof typeof counts] !== value) throw new ThirdPartyAuditionError("third-party audition summary does not match candidate evidence")
  }
  return report
}

function count(report: ThirdPartyAuditionReport, stage: z.infer<typeof auditionStageName>): number {
  const key = stage === "endpoint_live" ? "endpointLive" : stage === "quote_capable" ? "quoteCapable" : stage
  return report.candidates.filter((item) => item.stages[key].outcome === "VERIFIED").length
}
