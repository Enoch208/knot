import snapshot from "./discovery-coverage.snapshot.json"

export interface RegistryCoverage {
  chainId: number
  label: string
  registeredTotal: number
  observedAtUtc: string
  requestUri: string
}

export interface DiscoveryCoverage {
  updatedAtUtc: string
  registries: readonly RegistryCoverage[]
  callableThroughKnot: number
  externallyOperatedHiresAttempted: number
  externallyOperatedHiresDelivered: number
  limitation: string
}

export const discoveryCoverage: DiscoveryCoverage = snapshot
