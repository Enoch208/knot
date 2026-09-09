import type { Pool, PoolClient } from "pg"
import { IdempotencyConflictError } from "./errors.ts"

export interface NegotiationEndpointSafeDetails {
  schemaVersion: "knot.owned-seller-endpoint-observation/1"
  sellerKey: "healthguard" | "rangepilot" | "gridquant" | "yieldscout"
  transportVersion: "knot.owned-seller-client/1"
  httpStatus: 200
  responseByteLength: number
  responseSha256: `0x${string}`
}

export interface AppendNegotiationEndpointObservationInput {
  id: string
  agentRecordId: string
  endpoint: string
  latencyMilliseconds: number
  safeDetails: NegotiationEndpointSafeDetails
  observedAt: Date
}

export interface NegotiationEndpointObservationRecord extends AppendNegotiationEndpointObservationInput {
  requestType: "negotiate"
  result: "SUCCESS"
  createdAt: Date
}

export interface NegotiationEndpointObservationAppend {
  record: NegotiationEndpointObservationRecord
  created: boolean
}

interface EndpointObservationRow {
  id: string
  agent_id: string
  endpoint: string
  request_type: string
  result: string
  latency_milliseconds: number
  safe_details: unknown
  observed_at: Date
  created_at: Date
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/
const digest = /^0x[0-9a-f]{64}$/

const normalize = (input: AppendNegotiationEndpointObservationInput): AppendNegotiationEndpointObservationInput => {
  let url: URL
  try {
    url = new URL(input.endpoint)
  } catch {
    throw new RangeError("endpoint observation is invalid")
  }
  const details = input.safeDetails
  if (
    !identifier.test(input.id) ||
    !identifier.test(input.agentRecordId) ||
    input.endpoint.length > 2048 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href !== input.endpoint ||
    !Number.isSafeInteger(input.latencyMilliseconds) ||
    input.latencyMilliseconds < 0 ||
    !(input.observedAt instanceof Date) ||
    !Number.isFinite(input.observedAt.getTime()) ||
    details.schemaVersion !== "knot.owned-seller-endpoint-observation/1" ||
    !["healthguard", "rangepilot", "gridquant", "yieldscout"].includes(details.sellerKey) ||
    details.transportVersion !== "knot.owned-seller-client/1" ||
    details.httpStatus !== 200 ||
    !Number.isSafeInteger(details.responseByteLength) ||
    details.responseByteLength < 1 ||
    details.responseByteLength > 131_072 ||
    !digest.test(details.responseSha256) ||
    JSON.stringify(Object.keys(details).sort()) !== JSON.stringify([
      "httpStatus",
      "responseByteLength",
      "responseSha256",
      "schemaVersion",
      "sellerKey",
      "transportVersion",
    ])
  ) {
    throw new RangeError("endpoint observation is invalid")
  }
  return { ...input, safeDetails: { ...details } }
}

const mapRecord = (row: EndpointObservationRow): NegotiationEndpointObservationRecord => {
  const input = normalize({
    id: row.id,
    agentRecordId: row.agent_id,
    endpoint: row.endpoint,
    latencyMilliseconds: row.latency_milliseconds,
    safeDetails: row.safe_details as NegotiationEndpointSafeDetails,
    observedAt: row.observed_at,
  })
  if (row.request_type !== "negotiate" || row.result !== "SUCCESS") {
    throw new Error("stored endpoint observation failed integrity validation")
  }
  return { ...input, requestType: "negotiate", result: "SUCCESS", createdAt: row.created_at }
}

const same = (
  record: NegotiationEndpointObservationRecord,
  input: AppendNegotiationEndpointObservationInput,
): boolean =>
  record.id === input.id &&
  record.agentRecordId === input.agentRecordId &&
  record.endpoint === input.endpoint &&
  record.latencyMilliseconds === input.latencyMilliseconds &&
  record.observedAt.getTime() === input.observedAt.getTime() &&
  JSON.stringify(record.safeDetails) === JSON.stringify(input.safeDetails)

export class EndpointObservationRepository {
  private readonly executor: Pick<Pool, "query">

  constructor(executor: Pool | PoolClient) {
    this.executor = executor
  }

  async appendNegotiationSuccess(
    input: AppendNegotiationEndpointObservationInput,
  ): Promise<NegotiationEndpointObservationAppend> {
    const normalized = normalize(input)
    const inserted = await this.executor.query<EndpointObservationRow>(
      "INSERT INTO endpoint_observations (id, agent_id, endpoint, request_type, result, latency_milliseconds, safe_details, observed_at) VALUES ($1, $2, $3, 'negotiate', 'SUCCESS', $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING RETURNING *",
      [normalized.id, normalized.agentRecordId, normalized.endpoint, normalized.latencyMilliseconds, JSON.stringify(normalized.safeDetails), normalized.observedAt],
    )
    if (inserted.rows[0]) return { record: mapRecord(inserted.rows[0]), created: true }
    const existing = await this.executor.query<EndpointObservationRow>(
      "SELECT * FROM endpoint_observations WHERE id = $1",
      [normalized.id],
    )
    const row = existing.rows[0]
    if (!row) throw new IdempotencyConflictError()
    const record = mapRecord(row)
    if (!same(record, normalized)) throw new IdempotencyConflictError()
    return { record, created: false }
  }
}
