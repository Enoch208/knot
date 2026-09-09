import { z } from "zod"

export const chainId = z.union([z.literal(56), z.literal(97)])

export const capability = z.enum(["analysis", "monitoring", "execution"])

export const category = z.enum(["rebalancing", "grid", "yield", "health", "security"])

export const evidenceClass = z.enum([
  "mainnet_observation",
  "testnet_observation",
  "historical_replay",
  "synthetic_fixture",
  "publisher_claim",
])

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address")
  .transform((value) => value.toLowerCase() as `0x${string}`)

export const hexDigest = z.string().regex(/^0x[0-9a-f]{64}$/, "expected a 32-byte hex digest")

export const baseUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "expected a non-negative integer string in base units")

export const amount = z
  .object({
    chainId,
    token: address,
    units: baseUnits,
    decimals: z.number().int().min(0).max(36),
  })
  .strict()

export const agentKey = z.object({ chainId, registry: address, agentId: z.string().min(1) }).strict()

export const snapshotSource = z
  .object({ uri: z.string().min(1), contentHash: hexDigest, method: z.string().min(1) })
  .strict()

export const snapshotRef = z
  .object({
    schemaVersion: z.literal("knot.snapshot/1"),
    snapshotId: z.string().min(1),
    chainId,
    blockNumber: baseUnits,
    blockHash: hexDigest,
    blockTimestampUtc: z.iso.datetime(),
    capturedAtUtc: z.iso.datetime(),
    evidenceClass,
    canonicality: z.enum(["confirmed", "unconfirmed", "orphaned"]),
    sources: z.array(snapshotSource).min(1),
  })
  .strict()

export type ChainId = z.infer<typeof chainId>
export type Capability = z.infer<typeof capability>
export type Category = z.infer<typeof category>
export type EvidenceClass = z.infer<typeof evidenceClass>
export type Address = z.infer<typeof address>
export type Amount = z.infer<typeof amount>
export type AgentKey = z.infer<typeof agentKey>
export type SnapshotRef = z.infer<typeof snapshotRef>
