import snapshot from "./directory.snapshot.json"

export interface DirectoryEntry {
  agentId: string
  registry: string
  chainId: number
  ownerAddress: string
  name: string
  nameProvenance: string
  description: string
  indexVerified: boolean
  feedbackCount: number | null
  averageScore: number | null
  averageScoreProvenance: string
  knotVerified: boolean
}

export interface DirectoryAggregates {
  claimedNames: number
  indexVerified: number
  withAnyFeedback: number
  withAnyScore: number
  defaultScaffoldNames: number
  distinctOwners: number
}

export interface DirectorySnapshot {
  observedAtUtc: string
  requestUri: string
  chainId: number
  registeredTotal: number
  sampleSize: number
  coverageStatement: string
  aggregates: DirectoryAggregates
  entries: readonly DirectoryEntry[]
}

export const directorySnapshot: DirectorySnapshot = snapshot as DirectorySnapshot

export const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`
