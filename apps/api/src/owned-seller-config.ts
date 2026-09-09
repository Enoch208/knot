import type { OwnedSellerCredentials } from "../../../packages/security/src/owned-seller-client.ts"
import type { ExpectedPublicSeller } from "../../../packages/discovery/src/public-sellers.ts"

export type OwnedSellerKey = ExpectedPublicSeller["key"]
export type OwnedSellerCredentialMap = Readonly<Record<OwnedSellerKey, Readonly<OwnedSellerCredentials>>>

export type OwnedSellerConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; credentials: OwnedSellerCredentialMap }>

const disabled: OwnedSellerConfig = Object.freeze({ enabled: false })

export class OwnedSellerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OwnedSellerConfigError"
  }
}

export function loadOwnedSellerConfig(source: NodeJS.ProcessEnv): OwnedSellerConfig {
  const flag = source.KNOT_OWNED_SELLER_NEGOTIATION_ENABLED ?? "false"
  if (flag === "false") return disabled
  if (flag !== "true") {
    throw new OwnedSellerConfigError("KNOT_OWNED_SELLER_NEGOTIATION_ENABLED must be true or false")
  }
  const credentials = Object.freeze({
    healthguard: credential(source, "KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID", "KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET"),
    rangepilot: credential(source, "KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID", "KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET"),
    gridquant: credential(source, "KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_ID", "KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET"),
    yieldscout: credential(source, "KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_ID", "KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET"),
  } satisfies Record<OwnedSellerKey, Readonly<OwnedSellerCredentials>>)
  const secrets = Object.values(credentials).map((item) => item.clientSecret)
  if (new Set(secrets).size !== secrets.length) {
    throw new OwnedSellerConfigError("owned seller client secrets must be distinct")
  }
  if (source.KNOT_API_AUTH_TOKEN !== undefined && secrets.includes(source.KNOT_API_AUTH_TOKEN)) {
    throw new OwnedSellerConfigError("owned seller client secrets must differ from KNOT_API_AUTH_TOKEN")
  }
  return Object.freeze({ enabled: true, credentials })
}

function credential(
  source: NodeJS.ProcessEnv,
  clientIdKey: string,
  clientSecretKey: string,
): Readonly<OwnedSellerCredentials> {
  const clientId = printable(source[clientIdKey], 1, 256, clientIdKey)
  const clientSecret = printable(source[clientSecretKey], 16, 4_096, clientSecretKey)
  return Object.freeze({ clientId, clientSecret })
}

function printable(value: string | undefined, minimum: number, maximum: number, key: string): string {
  if (value === undefined || value.length < minimum || value.length > maximum || !/^[\x20-\x7e]+$/u.test(value)) {
    throw new OwnedSellerConfigError(`${key} is invalid`)
  }
  return value
}
