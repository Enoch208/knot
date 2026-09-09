import { z } from "zod"
import { address, baseUnits, hexDigest } from "../../contracts/src/primitives.ts"

const nonZeroBaseUnits = baseUnits.refine((value) => BigInt(value) > 0n, "expected a positive integer string")
const sourceLocation = z.string().regex(/^.+:[1-9][0-9]*(-[1-9][0-9]*)?$/, "expected path:start or path:start-end")
export const shieldRuleId = z.enum([
  "ERC1967_ADMIN",
  "ERC1967_BEACON",
  "OWNER_MINT",
  "OWNER_PAUSE",
  "UPGRADE_AUTHORITY",
  "REENTRANCY_EXTERNAL_CALL",
  "UNCHECKED_LOW_LEVEL_CALL",
  "CONTROLLED_DELEGATECALL",
])

const slotObservation = z.discriminatedUnion("status", [
  z.object({ status: z.literal("value"), value: address, rawValue: hexDigest }).strict(),
  z.object({ status: z.literal("empty"), value: z.null(), rawValue: z.literal(`0x${"0".repeat(64)}`) }).strict(),
  z.object({ status: z.literal("unreadable"), value: z.null(), rawValue: z.null(), reason: z.string().min(1) }).strict(),
])

const verifiedSource = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      compiler: z.string().min(1),
      sourceBundleUri: z.string().url(),
      sourceBundleHash: hexDigest,
      license: z.string().min(1).nullable(),
    })
    .strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
])

const runtimeBytecode = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), codeHash: hexDigest, sizeBytes: z.number().int().positive() }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
])

const verifiedPrivilege = z
  .object({
    kind: z.literal("verified_privilege"),
    ruleId: z.enum(["OWNER_MINT", "OWNER_PAUSE", "UPGRADE_AUTHORITY"]),
    title: z.string().min(1),
    functionSignature: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)$/),
    affectedAddress: address,
    sourceBundleHash: hexDigest,
    sourceLocation,
    accessControl: z.string().min(1),
    externalReachabilityConfirmed: z.literal(true),
    consequence: z.string().min(1),
    mitigation: z.string().min(1),
  })
  .strict()

const analyzerObservation = z
  .object({
    kind: z.literal("static_analyzer"),
    ruleId: z.enum(["REENTRANCY_EXTERNAL_CALL", "UNCHECKED_LOW_LEVEL_CALL", "CONTROLLED_DELEGATECALL"]),
    title: z.string().min(1),
    affectedAddress: address,
    sourceBundleHash: hexDigest,
    sourceLocation,
    analyzer: z.literal("slither"),
    analyzerVersion: z.string().min(1),
    validation: z.enum(["confirmed", "unresolved", "rejected"]),
    severity: z.enum(["critical", "high", "medium", "low", "informational"]),
    severityRationale: z.string().min(1),
    preconditions: z.array(z.string().min(1)).min(1),
    consequence: z.string().min(1),
    mitigation: z.string().min(1),
    validationMethod: z.string().min(1),
  })
  .strict()

export const shieldRequest = z
  .object({
    schemaVersion: z.literal("knot.shield.request/1"),
    taskId: z.string().min(1),
    target: z.object({ chainId: z.literal(56), address }).strict(),
    maxSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    requestedChecks: z
      .array(z.enum(["source_availability", "erc1967_proxy_slots", "verified_privileges", "static_analysis"]))
      .min(1),
    snapshot: z
      .object({
        schemaVersion: z.literal("knot.shield.snapshot/1"),
        targetAddress: address,
        chainId: z.literal(56),
        blockNumber: nonZeroBaseUnits,
        blockHash: hexDigest,
        blockTimestampUtc: z.iso.datetime(),
        capturedAtUtc: z.iso.datetime(),
        canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
        runtimeBytecode,
        verifiedSource,
        proxySlots: z
          .object({
            implementation: slotObservation,
            admin: slotObservation,
            beacon: slotObservation,
          })
          .strict(),
        observations: z.array(z.discriminatedUnion("kind", [verifiedPrivilege, analyzerObservation])),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.requestedChecks).size !== value.requestedChecks.length) {
      context.addIssue({ code: "custom", path: ["requestedChecks"], message: "requested checks must be unique" })
    }
  })

const evidence = z
  .object({
    kind: z.enum(["storage_slot", "verified_source", "static_analyzer"]),
    reference: z.string().min(1),
    contentHash: hexDigest.nullable(),
  })
  .strict()

export const shieldFinding = z
  .object({
    ruleId: shieldRuleId,
    title: z.string().min(1),
    category: z.enum(["VULNERABILITY", "PRIVILEGED_CAPABILITY", "CONFIGURATION_RISK"]),
    severity: z.enum(["critical", "high", "medium", "low", "informational"]),
    severityRationale: z.string().min(1),
    confidence: z.enum(["high", "medium"]),
    affectedAddress: address,
    affectedFunction: z.string().nullable(),
    sourceLocation: sourceLocation.nullable(),
    evidence: z.array(evidence).min(1),
    preconditions: z.array(z.string().min(1)).min(1),
    potentialConsequence: z.string().min(1),
    mitigation: z.string().min(1),
    validationMethod: z.string().min(1),
  })
  .strict()

const unresolved = z
  .object({
    check: z.string().min(1),
    reason: z.string().min(1),
    consequence: z.string().min(1),
  })
  .strict()

export const shieldArtifact = z
  .object({
    schemaVersion: z.literal("knot.shield.artifact/1"),
    category: z.literal("security"),
    capability: z.literal("analysis"),
    taskId: z.string().nullable(),
    status: z.enum(["ASSESSED", "PARTIAL", "REFUSED", "INVALID_REQUEST"]),
    reasonCode: z.string().nullable(),
    assessedAtUtc: z.iso.datetime(),
    target: z.object({ chainId: z.literal(56), address: address.nullable() }).strict(),
    snapshot: z
      .object({
        blockNumber: baseUnits.nullable(),
        blockHash: hexDigest.nullable(),
        sourceBundleHash: hexDigest.nullable(),
      })
      .strict(),
    proxy: z
      .object({
        standard: z.literal("ERC-1967"),
        implementation: address.nullable(),
        admin: address.nullable(),
        beacon: address.nullable(),
      })
      .strict(),
    findings: z.array(shieldFinding),
    negativeControls: z.array(z.object({ ruleId: shieldRuleId, reason: z.string().min(1) }).strict()),
    unresolved: z.array(unresolved),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()

export type ShieldRequest = z.infer<typeof shieldRequest>
export type ShieldArtifact = z.infer<typeof shieldArtifact>
export type ShieldFinding = ShieldArtifact["findings"][number]
export type ShieldSnapshot = ShieldRequest["snapshot"]
