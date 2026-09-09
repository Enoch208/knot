import { keccak256, stringToHex, type Hash } from "viem"
import { z } from "zod"

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`)

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/)
const calldataHash = z.string().regex(/^0x[0-9a-f]{64}$/)

export const evmTransactionIntent = z
  .object({
    schemaVersion: z.literal("knot.evm-transaction-intent/1"),
    taskId: z.string().min(1),
    actionSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    semanticAction: z.string().min(1),
    signerAddress: address,
    accountAddress: address,
    chainId: z.union([z.literal(56), z.literal(97)]),
    nonce: decimal,
    destination: address,
    valueUnits: decimal,
    calldataHash,
    gasLimit: decimal,
    gasPriceUnits: decimal,
  })
  .strict()
  .refine((value) => value.signerAddress === value.accountAddress, {
    message: "direct EOA transaction intent requires signer and account to match",
    path: ["accountAddress"],
  })

export type EvmTransactionIntent = z.infer<typeof evmTransactionIntent>

export function parseEvmTransactionIntent(input: unknown): EvmTransactionIntent {
  return evmTransactionIntent.parse(input)
}

export function canonicalEvmTransactionIntentJson(input: unknown): string {
  const value = parseEvmTransactionIntent(input)
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    taskId: value.taskId,
    actionSequence: value.actionSequence,
    semanticAction: value.semanticAction,
    signerAddress: value.signerAddress,
    accountAddress: value.accountAddress,
    chainId: value.chainId,
    nonce: value.nonce,
    destination: value.destination,
    valueUnits: value.valueUnits,
    calldataHash: value.calldataHash,
    gasLimit: value.gasLimit,
    gasPriceUnits: value.gasPriceUnits,
  })
}

export function hashEvmTransactionIntent(input: unknown): Hash {
  return keccak256(stringToHex(canonicalEvmTransactionIntentJson(input)))
}
