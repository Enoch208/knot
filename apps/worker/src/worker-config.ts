import { z } from "zod"
import { validateSafeUrl } from "../../../packages/security/src/index.ts"

const environment = z.object({
  DATABASE_URL: z.string().min(1),
  KNOT_WORKER_POLL_MILLISECONDS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  KNOT_CHAIN_RECOVERY_ENABLED: z.enum(["true", "false"]).default("false"),
  KNOT_BSC_MAINNET_RPC_URL: z.string().min(1).optional(),
  KNOT_BSC_TESTNET_RPC_URL: z.string().min(1).optional(),
  KNOT_CHAIN_56_CONFIRMATIONS: z.coerce.number().int().min(15).max(100).default(15),
  KNOT_CHAIN_97_CONFIRMATIONS: z.coerce.number().int().min(2).max(100).default(2),
  KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS: z.coerce.number().int().min(3_000).max(300_000).default(30_000),
  KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  KNOT_CHAIN_RECOVERY_SCAN_LIMIT: z.coerce.number().int().min(1).max(4).default(2),
}).passthrough()

export interface ChainRecoveryConfig {
  rpcUrls: Readonly<Record<56 | 97, string>>
  confirmationPolicy: Readonly<Record<56 | 97, number>>
  leaseMilliseconds: number
  observationTimeoutMilliseconds: number
  scanLimit: number
}

export interface WorkerConfig {
  databaseUrl: string
  pollMilliseconds: number
  chainRecovery: ChainRecoveryConfig | null
}

export function parseWorkerConfig(input: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = environment.parse(input)
  if (parsed.KNOT_CHAIN_RECOVERY_ENABLED === "false") {
    return {
      databaseUrl: parsed.DATABASE_URL,
      pollMilliseconds: parsed.KNOT_WORKER_POLL_MILLISECONDS,
      chainRecovery: null,
    }
  }
  if (!parsed.KNOT_BSC_MAINNET_RPC_URL || !parsed.KNOT_BSC_TESTNET_RPC_URL) {
    throw new Error("enabled chain recovery requires both BSC RPC URLs")
  }
  if (parsed.KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS <= parsed.KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS + 2_000) {
    throw new Error("chain recovery lease must exceed the observation timeout and transition margin")
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    pollMilliseconds: parsed.KNOT_WORKER_POLL_MILLISECONDS,
    chainRecovery: {
      rpcUrls: {
        56: rpcUrl(parsed.KNOT_BSC_MAINNET_RPC_URL),
        97: rpcUrl(parsed.KNOT_BSC_TESTNET_RPC_URL),
      },
      confirmationPolicy: {
        56: parsed.KNOT_CHAIN_56_CONFIRMATIONS,
        97: parsed.KNOT_CHAIN_97_CONFIRMATIONS,
      },
      leaseMilliseconds: parsed.KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS,
      observationTimeoutMilliseconds: parsed.KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS,
      scanLimit: parsed.KNOT_CHAIN_RECOVERY_SCAN_LIMIT,
    },
  }
}

function rpcUrl(input: string): string {
  const url = validateSafeUrl(input)
  if (url.search !== "" || url.hash !== "") throw new Error("RPC URL cannot contain a query or fragment")
  return url.href
}
