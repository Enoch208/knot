import { z } from "zod"
import { address } from "../../../packages/contracts/src/primitives.ts"
import type { ApiConfig } from "./types.ts"

const environment = z.object({
  DATABASE_URL: z.string().min(1),
  KNOT_API_AUTH_TOKEN: z.string().min(32),
  KNOT_API_BUYER_ADDRESS: address,
  KNOT_API_ALLOWED_ORIGIN: z.url(),
  KNOT_API_HOST: z.string().min(1).default("127.0.0.1"),
  KNOT_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  KNOT_API_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
})

export interface ServerConfig {
  databaseUrl: string
  host: string
  port: number
  api: ApiConfig
}

export const loadServerConfig = (source: NodeJS.ProcessEnv): ServerConfig => {
  const parsed = environment.parse(source)
  const origin = new URL(parsed.KNOT_API_ALLOWED_ORIGIN)
  if (origin.origin !== parsed.KNOT_API_ALLOWED_ORIGIN) {
    throw new Error("KNOT_API_ALLOWED_ORIGIN must contain only a URL origin")
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.KNOT_API_HOST,
    port: parsed.KNOT_API_PORT,
    api: {
      authToken: parsed.KNOT_API_AUTH_TOKEN,
      buyerAddress: parsed.KNOT_API_BUYER_ADDRESS,
      allowedOrigin: origin.origin,
      maxBodyBytes: parsed.KNOT_API_MAX_BODY_BYTES,
      now: () => new Date(),
    },
  }
}
