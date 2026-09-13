import type { AgentProfile, AgentSlug } from "./agent-catalog.ts"

export type AgentEndpointObservation = {
  slug: AgentSlug
  state: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE"
  cardAvailable: boolean
  proofAvailable: boolean
  checkedAtUtc: string
  latencyMs: number | null
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const endpointUrl = (origin: string, path: string): string => new URL(path, `${origin}/`).toString()

export async function observeAgentEndpoint(
  profile: Pick<AgentProfile, "slug" | "endpoint">,
  options: { fetcher?: Fetcher; now?: () => number; checkedAt?: () => Date } = {},
): Promise<AgentEndpointObservation> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? (() => performance.now())
  const checkedAt = options.checkedAt ?? (() => new Date())
  const startedAt = now()

  const request = (path: string) => fetcher(endpointUrl(profile.endpoint, path), {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(4_000),
  })

  const [card, proof] = await Promise.allSettled([
    request("/.well-known/agent-card.json"),
    request("/.well-known/agent-registration.json"),
  ])
  const cardAvailable = card.status === "fulfilled" && card.value.ok
  const proofAvailable = proof.status === "fulfilled" && proof.value.ok
  const state = cardAvailable && proofAvailable
    ? "AVAILABLE"
    : cardAvailable || proofAvailable
      ? "DEGRADED"
      : "UNAVAILABLE"

  return {
    slug: profile.slug,
    state,
    cardAvailable,
    proofAvailable,
    checkedAtUtc: checkedAt().toISOString(),
    latencyMs: cardAvailable || proofAvailable ? Math.max(0, Math.round(now() - startedAt)) : null,
  }
}

export async function observeAgentEndpoints(
  profiles: readonly Pick<AgentProfile, "slug" | "endpoint">[],
  options: { fetcher?: Fetcher; now?: () => number; checkedAt?: () => Date } = {},
): Promise<AgentEndpointObservation[]> {
  return await Promise.all(profiles.map((profile) => observeAgentEndpoint(profile, options)))
}
