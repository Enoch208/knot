import { z } from "zod"
import { chainId } from "../../contracts/src/primitives.ts"

export const provenanceLabel = z.enum([
  "LIVE",
  "ONCHAIN",
  "VERIFIED",
  "REPLAY",
  "CLAIMED",
  "UNAVAILABLE",
])

export type ProvenanceLabel = z.infer<typeof provenanceLabel>

export const provenance = z
  .object({
    label: provenanceLabel,
    source: z.string().min(1),
    observedAtUtc: z.string().datetime(),
    chainId: chainId.nullable(),
    blockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/, "expected a non-negative integer string")
      .nullable(),
    uri: z.string().min(1).nullable(),
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.label === "UNAVAILABLE" && value.unavailableReason === null) {
      ctx.addIssue({
        code: "custom",
        message: "an UNAVAILABLE label must carry an unavailableReason",
        path: ["unavailableReason"],
      })
    }
    if (value.label !== "UNAVAILABLE" && value.unavailableReason !== null) {
      ctx.addIssue({
        code: "custom",
        message: "only an UNAVAILABLE label may carry an unavailableReason",
        path: ["unavailableReason"],
      })
    }
    if (value.label === "ONCHAIN" && (value.chainId === null || value.blockNumber === null)) {
      ctx.addIssue({
        code: "custom",
        message: "an ONCHAIN label must carry chainId and blockNumber",
        path: ["blockNumber"],
      })
    }
  })

export type Provenance = z.infer<typeof provenance>

function enforceValueLabelCoupling(entry: unknown, ctx: z.RefinementCtx): void {
  const parsed = entry as { value: unknown; provenance: Provenance }
  if (parsed.provenance.label === "UNAVAILABLE" && parsed.value !== null) {
    ctx.addIssue({
      code: "custom",
      message: "an UNAVAILABLE metric must not carry a value",
      path: ["value"],
    })
  }
  if (parsed.provenance.label !== "UNAVAILABLE" && parsed.value === null) {
    ctx.addIssue({
      code: "custom",
      message: "a null metric must be labeled UNAVAILABLE with a reason",
      path: ["provenance", "label"],
    })
  }
}

export const labeledValue = <T extends z.ZodType>(value: T) =>
  z.object({ value: z.nullable(value), provenance }).strict().superRefine(enforceValueLabelCoupling)

export interface LabeledValue<T> {
  value: T | null
  provenance: Provenance
}

export function unavailable(
  source: string,
  reason: string,
  observedAtUtc: string,
): LabeledValue<never> {
  return {
    value: null,
    provenance: {
      label: "UNAVAILABLE",
      source,
      observedAtUtc,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: reason,
    },
  }
}

export function live<T>(
  value: T,
  source: string,
  observedAtUtc: string,
  uri: string | null = null,
): LabeledValue<T> {
  return {
    value,
    provenance: {
      label: "LIVE",
      source,
      observedAtUtc,
      chainId: null,
      blockNumber: null,
      uri,
      unavailableReason: null,
    },
  }
}

export function onchain<T>(
  value: T,
  source: string,
  observedAtUtc: string,
  observedChainId: 56 | 97,
  blockNumber: bigint,
): LabeledValue<T> {
  return {
    value,
    provenance: {
      label: "ONCHAIN",
      source,
      observedAtUtc,
      chainId: observedChainId,
      blockNumber: blockNumber.toString(),
      uri: null,
      unavailableReason: null,
    },
  }
}

export function claimed<T>(
  value: T,
  source: string,
  observedAtUtc: string,
  uri: string | null = null,
): LabeledValue<T> {
  return {
    value,
    provenance: {
      label: "CLAIMED",
      source,
      observedAtUtc,
      chainId: null,
      blockNumber: null,
      uri,
      unavailableReason: null,
    },
  }
}

export function freshnessSeconds(entry: LabeledValue<unknown>, nowUtc: string): number | null {
  if (entry.provenance.label === "UNAVAILABLE") return null
  const observed = Date.parse(entry.provenance.observedAtUtc)
  const now = Date.parse(nowUtc)
  if (Number.isNaN(observed) || Number.isNaN(now)) return null
  return Math.max(0, Math.floor((now - observed) / 1000))
}
