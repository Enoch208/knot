import { z } from "zod"

export const claimStatuses = ["SUPPORTED", "PARTIAL", "UNMEASURED", "NOT_CLAIMED"] as const
export const claimEvidenceClasses = ["mainnet_observation", "testnet_observation", "historical_replay", "synthetic_fixture", "publisher_claim"] as const

const utc = z.iso.datetime()
const httpsUrl = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === "https:" && url.username === "" && url.password === ""
}, "URL must use HTTPS without embedded credentials")
const repositoryPath = z.string().min(1).max(512)
const command = z.string().min(1).max(512)
const digest = z.string().regex(/^0x[0-9a-f]{64}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const baseUnits = z.string().regex(/^(0|[1-9][0-9]*)$/)
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValue),
  z.record(z.string(), jsonValue),
]))
const jsonObject = z.record(z.string(), jsonValue).refine((value) => Object.keys(value).length > 0, "object must not be empty")
const pathOnlyTypes = ["deployment_evidence", "frozen_ground_truth", "manual_validation", "measured_evaluation", "preserved_evaluation_runs", "raw_analyzer_capture", "repository_file", "testnet_authority_evidence", "testnet_job_evidence"] as const
const pathOnly = z.object({ type: z.enum(pathOnlyTypes), path: repositoryPath }).strict()
const repositoryTest = z.object({ type: z.literal("repository_test"), path: repositoryPath, command }).strict()
const repositoryCommand = z.object({ type: z.literal("repository_command"), path: repositoryPath, command, observedStatus: z.string().min(1) }).strict()
const pairedDataset = z.object({ type: z.literal("paired_experiment_dataset"), path: repositoryPath, command }).strict()
const frozenRules = z.object({ type: z.literal("frozen_rules"), path: repositoryPath, contentHash: digest }).strict()
const httpsProbe = z.object({ type: z.literal("https_probe"), url: httpsUrl, httpStatus: z.number().int().min(100).max(599), observation: jsonObject }).strict()
const deliverable = z.object({ type: z.literal("deliverable"), url: httpsUrl, sha256 }).strict()
const transaction = z
  .object({
    type: z.literal("testnet_transaction"),
    role: z.string().min(1).optional(),
    transactionHash,
    url: httpsUrl,
    receiptStatus: z.enum(["success", "reverted"]),
    blockNumber: baseUnits,
  })
  .strict()
const identityRead = z.object({ type: z.literal("testnet_identity_read"), network: z.string().min(1), chainId: z.number().int().positive(), result: jsonObject }).strict()
const negotiation = z
  .object({
    type: z.literal("authenticated_negotiation_observation"),
    result: z.string().min(1),
    signaturePresent: z.boolean(),
    chainId: z.number().int().positive(),
    priceBaseUnits: baseUnits,
    verifyingContract: address,
  })
  .strict()

export const claimSource = z.discriminatedUnion("type", [
  pathOnly,
  repositoryTest,
  repositoryCommand,
  pairedDataset,
  frozenRules,
  httpsProbe,
  deliverable,
  transaction,
  identityRead,
  negotiation,
])

export const claimEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    claim: z.string().trim().min(1),
    status: z.enum(claimStatuses),
    evidenceClasses: z.array(z.enum(claimEvidenceClasses)).min(1),
    scope: jsonObject,
    observedAtUtc: utc.optional(),
    observedOnDate: z.iso.date().optional(),
    observationWindow: z.object({ fromUtc: utc, toUtc: utc }).strict().refine((value) => Date.parse(value.fromUtc) <= Date.parse(value.toUtc), "observation window must be ordered").optional(),
    sources: z.array(claimSource).min(1),
    limitations: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.evidenceClasses).size !== value.evidenceClasses.length) context.addIssue({ code: "custom", path: ["evidenceClasses"], message: "evidence classes must be unique" })
    if (new Set(value.limitations).size !== value.limitations.length) context.addIssue({ code: "custom", path: ["limitations"], message: "limitations must be unique" })
    if ([value.observedAtUtc, value.observedOnDate, value.observationWindow].filter((item) => item !== undefined).length > 1) context.addIssue({ code: "custom", path: ["observedAtUtc"], message: "claim must use only one observation time form" })
  })

export const claimLedger = z
  .object({
    schemaVersion: z.literal("knot.claims/1"),
    revision: z.object({ baseCommit: z.string().regex(/^[0-9a-f]{40}$/), branch: z.string().min(1) }).strict(),
    updatedAtUtc: utc,
    statusDefinitions: z
      .object({
        SUPPORTED: z.literal("The listed evidence supports the claim within its stated scope."),
        PARTIAL: z.literal("The listed evidence supports only part of the claim; limitations identify the unsupported portion."),
        UNMEASURED: z.literal("No benchmark or representative measured dataset supports the claim."),
        NOT_CLAIMED: z.literal("The capability is explicitly outside the current submission claim set."),
      })
      .strict(),
    evidenceClassDefinitions: z
      .object({
        mainnet_observation: z.literal("A time-bound read from a mainnet network."),
        testnet_observation: z.literal("A time-bound read or interaction on a test network."),
        historical_replay: z.literal("A result produced by replaying a fixed historical dataset."),
        synthetic_fixture: z.literal("A deterministic result produced from controlled fixture data."),
        publisher_claim: z.literal("A statement or status returned by the operator's own service."),
      })
      .strict(),
    claims: z.array(claimEntry).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.claims.map((claim) => claim.id)
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["claims"], message: "claim IDs must be unique" })
  })

export type ClaimLedger = z.infer<typeof claimLedger>
export type ClaimSource = z.infer<typeof claimSource>
