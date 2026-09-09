import { z } from "zod"
import { safeFetch } from "../../security/src/index.ts"
import type { TaskSpec } from "../../contracts/src/task.ts"

export const BSC_TESTNET_ERC8004_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const
const registrationRegistry = `eip155:97:${BSC_TESTNET_ERC8004_REGISTRY}`
export type OwnedSellerCategory = Exclude<TaskSpec["category"], "security">

export interface ExpectedPublicSeller {
  key: "healthguard" | "rangepilot" | "gridquant" | "yieldscout"
  category: OwnedSellerCategory
  origin: `https://${string}`
  cardName: string
  oauthScope: string
  registry: typeof BSC_TESTNET_ERC8004_REGISTRY
  agentId: number
  owner: `0x${string}`
}

export const expectedPublicSellers: readonly ExpectedPublicSeller[] = Object.freeze([
  Object.freeze({
    key: "healthguard",
    category: "health",
    origin: "https://knot-health.truematchx.com",
    cardName: "healthguard-agent",
    oauthScope: "knot:healthguard:invoke",
    registry: BSC_TESTNET_ERC8004_REGISTRY,
    agentId: 2295,
    owner: "0xaf7474d06f171e6fd72fc5af114b34f3d5af8389",
  }),
  Object.freeze({
    key: "rangepilot",
    category: "rebalancing",
    origin: "https://knot-range.truematchx.com",
    cardName: "KNOT RangePilot",
    oauthScope: "knot:rangepilot:invoke",
    registry: BSC_TESTNET_ERC8004_REGISTRY,
    agentId: 2297,
    owner: "0xe4fed886b4b9062486d4663c6962e14473bd7320",
  }),
  Object.freeze({
    key: "gridquant",
    category: "grid",
    origin: "https://knot-grid.truematchx.com",
    cardName: "KNOT GridQuant",
    oauthScope: "knot:gridquant:invoke",
    registry: BSC_TESTNET_ERC8004_REGISTRY,
    agentId: 2298,
    owner: "0x3d5355a97352f4d078016342ad117a5e88d5c74f",
  }),
  Object.freeze({
    key: "yieldscout",
    category: "yield",
    origin: "https://knot-yield.truematchx.com",
    cardName: "KNOT YieldScout",
    oauthScope: "knot:yieldscout:invoke",
    registry: BSC_TESTNET_ERC8004_REGISTRY,
    agentId: 2299,
    owner: "0x6fd04720c7fccb6dcebf6cf08dd6f5c764c7d8e3",
  }),
])

export function resolveOwnedSellerAuthority(
  category: TaskSpec["category"],
  storedEndpoint: string,
): ExpectedPublicSeller | null {
  if (category === "security") return null
  const expected = expectedPublicSellers.find((seller) => seller.category === category)
  if (expected === undefined) return null
  if (storedEndpoint !== expected.origin && storedEndpoint !== `${expected.origin}/`) return null
  return expected
}

const card = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    version: z.string().min(1),
    protocolVersion: z.literal("0.3.0"),
    preferredTransport: z.literal("JSONRPC"),
    skills: z.array(z.object({ id: z.string().min(1) }).passthrough()),
    securitySchemes: z
      .object({
        oauth2: z
          .object({
            type: z.literal("oauth2"),
            flows: z
              .object({
                clientCredentials: z
                  .object({
                    tokenUrl: z.string().url(),
                    scopes: z.record(z.string(), z.string()),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
    security: z.array(z.record(z.string(), z.array(z.string()))),
  })
  .passthrough()

const registrationProof = z
  .object({
    registrations: z.array(
      z.object({ agentId: z.number().int().nonnegative(), agentRegistry: z.string().min(1) }).strict(),
    ).min(1),
  })
  .strict()

export interface PublicSellerHttpReader {
  getJson(url: string): Promise<{ status: number; body: unknown }>
  postUnauthenticated(url: string): Promise<number>
}

export interface PublicSellerVerification {
  key: ExpectedPublicSeller["key"]
  outcome: "VERIFIED" | "MISMATCH" | "UNAVAILABLE"
  cardStatus: number | null
  registrationStatus: number | null
  unauthenticatedInvokeStatus: number | null
  errors: string[]
}

export async function verifyPublicSeller(
  reader: PublicSellerHttpReader,
  expected: ExpectedPublicSeller,
): Promise<PublicSellerVerification> {
  let cardResponse: { status: number; body: unknown }
  let proofResponse: { status: number; body: unknown }
  let unauthenticatedStatus: number
  try {
    [cardResponse, proofResponse, unauthenticatedStatus] = await Promise.all([
      reader.getJson(`${expected.origin}/.well-known/agent-card.json`),
      reader.getJson(`${expected.origin}/.well-known/agent-registration.json`),
      reader.postUnauthenticated(`${expected.origin}/`),
    ])
  } catch {
    return {
      key: expected.key,
      outcome: "UNAVAILABLE",
      cardStatus: null,
      registrationStatus: null,
      unauthenticatedInvokeStatus: null,
      errors: ["one or more public seller requests did not complete"],
    }
  }

  const errors: string[] = []
  if (cardResponse.status !== 200) errors.push(`agent card returned HTTP ${cardResponse.status}`)
  if (proofResponse.status !== 200) errors.push(`registration proof returned HTTP ${proofResponse.status}`)
  if (unauthenticatedStatus !== 401) errors.push(`unauthenticated invocation returned HTTP ${unauthenticatedStatus}`)

  const parsedCard = card.safeParse(cardResponse.body)
  if (!parsedCard.success) {
    errors.push("agent card does not satisfy required A2A and OAuth fields")
  } else {
    if (parsedCard.data.name !== expected.cardName) errors.push("agent card name does not match the release manifest")
    if (parsedCard.data.url !== `${expected.origin}/`) errors.push("agent card URL does not match its HTTPS origin")
    const skillIds = new Set(parsedCard.data.skills.map((skill) => skill.id))
    if (!skillIds.has("negotiate") || !skillIds.has("notify_funded")) errors.push("agent card lacks required commerce skills")
    const oauth = parsedCard.data.securitySchemes.oauth2.flows.clientCredentials
    if (oauth.tokenUrl !== `${expected.origin}/oauth/token`) errors.push("OAuth token URL is not same-origin")
    if (!(expected.oauthScope in oauth.scopes)) errors.push("OAuth scope is absent from the client-credentials flow")
    const boundSecurity = parsedCard.data.security.some((entry) => entry.oauth2?.includes(expected.oauthScope) === true)
    if (!boundSecurity) errors.push("agent card security requirement is not bound to the expected scope")
  }

  const parsedProof = registrationProof.safeParse(proofResponse.body)
  if (!parsedProof.success) {
    errors.push("domain registration proof does not match the closed schema")
  } else {
    const exact = parsedProof.data.registrations.some((entry) =>
      entry.agentId === expected.agentId && entry.agentRegistry === registrationRegistry,
    )
    if (!exact) errors.push("domain registration proof does not bind the expected chain-97 agent")
  }

  return {
    key: expected.key,
    outcome: errors.length === 0 ? "VERIFIED" : "MISMATCH",
    cardStatus: cardResponse.status,
    registrationStatus: proofResponse.status,
    unauthenticatedInvokeStatus: unauthenticatedStatus,
    errors,
  }
}

export function createFetchPublicSellerReader(timeoutMs = 15_000): PublicSellerHttpReader {
  return {
    async getJson(url) {
      const response = await safeFetch(url, {
        headers: { accept: "application/json" },
        maxBytes: 131_072,
        maxRedirects: 0,
        timeoutMs,
      })
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown
      } catch {
        body = null
      }
      return { status: response.status, body }
    },
    async postUnauthenticated(url) {
      const response = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "public-verifier", method: "message/send", params: {} }),
        maxBytes: 65_536,
        maxRedirects: 0,
        timeoutMs,
      })
      return response.status
    },
  }
}
