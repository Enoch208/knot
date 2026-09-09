import { buildDescriptionContent, buildJobDescription, NegotiationRequest, NegotiationResponse } from "@bnbagent/sdk/erc8183"
import { keccak256, recoverMessageAddress, toBytes } from "viem"
import { z } from "zod"

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/)
const positiveDecimal = z.string().regex(/^[1-9][0-9]*$/)
const zeroAddress = "0x0000000000000000000000000000000000000000" as const
export const KNOT_TESTNET_SELLER_ADDRESSES = Object.freeze([
  "0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389",
  "0xE4feD886b4b9062486d4663c6962E14473Bd7320",
  "0x3D5355A97352f4D078016342AD117a5E88D5C74f",
  "0x6fD04720c7FcCB6dCEBf6cF08dD6f5C764c7D8E3",
] as const)
const utc = z.iso.datetime()
const httpsUrl = z.url().refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
}, "URL must use HTTPS without embedded credentials")
const credentialFreeHttpUrl = z.url().refine((value) => {
  const parsed = new URL(value)
  return new Set(["http:", "https:"]).has(parsed.protocol) && parsed.username === "" && parsed.password === ""
}, "URL must use HTTP or HTTPS without embedded credentials")

const signatureBase = {
  valid: z.literal(true),
  signer: address,
  verificationBasis: z.literal("live-pre-funding"),
}

const erc1271Signature = z.discriminatedUnion("historicalRecheck", [
  z.object({
    ...signatureBase,
    method: z.literal("erc1271"),
    historicalRecheck: z.literal("UNAVAILABLE"),
    historicalRecheckReason: z.literal("public RPC historical state pruned"),
  }).strict(),
  z.object({
    ...signatureBase,
    method: z.literal("erc1271"),
    historicalRecheck: z.literal("VERIFIED_AT_CAPTURE"),
    historicalRecheckBlock: positiveDecimal,
    historicalRecheckObservedAtUtc: utc,
  }).strict(),
])

const signature = z.union([
  erc1271Signature,
  z.object({
    ...signatureBase,
    method: z.literal("eip191"),
    signedMessage: z.literal("negotiation_hash_utf8"),
    historicalRecheck: z.literal("NOT_APPLICABLE"),
    historicalRecheckReason: z.literal("EIP-191 signer recovery is independent of historical chain state"),
  }).strict(),
])

const terms = z.object({
  deliverables: z.string().trim().min(1).max(2_000),
  quality_standards: z.string().trim().min(1).max(2_000),
  evaluation_required: z.literal(true),
  evaluator_type: z.string().trim().min(1).max(100),
}).strict()

const transaction = z.object({
  hash: bytes32,
  status: z.literal("success"),
  blockNumber: positiveDecimal,
  blockHash: bytes32,
  timestamp: positiveDecimal,
  timestampUtc: utc,
  gasUsed: positiveDecimal,
  effectiveGasPriceWei: decimal,
}).strict()

const eventBase = {
  jobId: positiveDecimal,
  blockNumber: positiveDecimal,
  transactionHash: bytes32,
}

const jobCreatedEvent = z.object({
  ...eventBase,
  client: address,
  provider: address,
  evaluator: address,
  expiredAt: positiveDecimal,
}).strict()
const jobRegisteredEvent = z.object({ ...eventBase, policy: address, client: address }).strict()
const jobFundedEvent = z.object({ ...eventBase, client: address, provider: address, amount: positiveDecimal }).strict()
const jobFinalisedEvent = z.object({ ...eventBase, status: z.literal(5) }).strict()
const transferEvent = z.object({ blockNumber: positiveDecimal, transactionHash: bytes32, from: address, to: address, value: positiveDecimal }).strict()

export const externalPaidJobFailureEvidenceSchema = z.object({
  schemaVersion: z.literal("knot.external-paid-job-failure/1"),
  capturedAtUtc: utc,
  outcome: z.object({
    classification: z.literal("FAILURE"),
    reason: z.literal("EXPIRED_WITHOUT_DELIVERY"),
    deliveryReceived: z.literal(false),
    providerPaymentBaseUnits: z.literal("0"),
  }).strict(),
  network: z.object({
    name: z.literal("BSC testnet"),
    chainId: z.literal(97),
    realFunds: z.literal(false),
    mainnetWrites: z.literal(false),
    contracts: z.object({ commerce: address, router: address, registry: address, paymentToken: address }).strict(),
  }).strict(),
  identity: z.object({
    registry: address,
    agentId: positiveDecimal,
    name: z.string().trim().min(1).max(200),
    provider: address,
    ownerObservedBeforeFunding: address,
    ownerAtTerminal: address,
    buyer: address,
    knotSellerAddresses: z.array(address).length(4),
  }).strict(),
  operatorRelationship: z.literal("external_distinct_owner"),
  taskDescription: z.string().trim().min(1).max(8_000),
  quote: z.object({
    request: z.object({ task_description: z.string().trim().min(1).max(8_000), terms }).strict(),
    request_hash: bytes32,
    response: z.object({
      accepted: z.literal(true),
      terms: terms.extend({ price: positiveDecimal, currency: address }).strict(),
      estimated_completion_seconds: z.number().int().positive().max(86_400),
      quote_expires_at: z.number().int().positive(),
      negotiated_at: z.number().int().positive(),
    }).strict(),
    response_hash: bytes32,
    negotiation_hash: bytes32,
    provider_sig: bytes,
    chain_id: z.literal(97),
    verifying_contract: address,
  }).strict(),
  signature,
  safety: z.object({
    mainnetWritesAuthorized: z.literal(false),
    executionAuthorized: z.literal(false),
    maximumServicePaymentBaseUnits: positiveDecimal,
    paymentNetwork: z.literal("BSC testnet"),
    paymentToken: address,
  }).strict(),
  observations: z.object({
    cardUrl: httpsUrl,
    endpoint: httpsUrl,
    cardName: z.string().trim().min(1).max(200),
    publishedInvocationUrl: credentialFreeHttpUrl,
    registryNameMatchesCardName: z.boolean(),
    selectedEndpointMatchesPublishedUrl: z.boolean(),
    cardObservedAtUtc: utc,
    initialAllowanceBaseUnits: z.literal("0"),
    initialBuyerBalanceBaseUnits: positiveDecimal,
  }).strict(),
  onChainDescription: z.string().min(1).max(100_000),
  transactions: z.object({
    create: transaction,
    register: transaction,
    approve: transaction,
    setBudget: transaction,
    fund: transaction,
    refund: transaction,
    markExpired: transaction,
  }).strict(),
  events: z.object({
    created: z.array(jobCreatedEvent).length(1),
    registered: z.array(jobRegisteredEvent).length(1),
    funded: z.array(jobFundedEvent).length(1),
    submitted: z.array(z.never()).length(0),
    finalised: z.array(jobFinalisedEvent).length(1),
    refundTransfers: z.array(transferEvent).length(1),
  }).strict(),
  lifecycle: z.object({
    jobId: positiveDecimal,
    expiredAt: positiveDecimal,
    terminalStatus: z.literal("EXPIRED"),
    terminalStatusCode: z.literal(5),
    client: address,
    provider: address,
    evaluator: address,
    hook: address,
    budgetBaseUnits: positiveDecimal,
    deliverableHash: z.literal("0x0000000000000000000000000000000000000000000000000000000000000000"),
    submittedAt: z.literal("0"),
    deliverableUrl: z.null(),
    policy: z.literal(zeroAddress),
    disputeWindowSeconds: positiveDecimal,
    policySubmittedAt: z.literal("0"),
    disputed: z.literal(false),
    inflightJobCountAfterReconciliation: decimal,
  }).strict(),
  notify: z.object({
    observedAtUtc: utc,
    result: z.object({ status: z.literal("accepted"), job_id: z.number().int().positive(), note: z.string().trim().min(1) }).strict(),
  }).strict(),
  preRefundObservation: z.object({
    observedAtUtc: utc,
    status: z.literal(1),
    client: address,
    provider: address,
    evaluator: address,
    hook: address,
    budgetBaseUnits: positiveDecimal,
    expiredAt: positiveDecimal,
    deliverableHash: z.literal("0x0000000000000000000000000000000000000000000000000000000000000000"),
    submittedAt: z.literal("0"),
    deliverableUrl: z.null(),
  }).strict(),
  refund: z.object({
    observedAtUtc: utc,
    balanceBeforeBaseUnits: decimal,
    balanceAfterBaseUnits: decimal,
    refundedBaseUnits: positiveDecimal,
    terminalStatus: z.literal("EXPIRED"),
    reconciledAtUtc: utc,
  }).strict(),
  expectedPriceBaseUnits: positiveDecimal,
  limitations: z.array(z.string().trim().min(1).max(1_000)).min(4),
}).strict()

export type ExternalPaidJobFailureEvidence = z.infer<typeof externalPaidJobFailureEvidenceSchema>

export type ExternalPaidJobSignatureVerification =
  | { method: "erc1271"; status: "CAPTURE_ONLY"; signer: string }
  | { method: "eip191"; status: "OFFLINE_REVERIFIED"; signer: string }

export function deriveExternalPaidJobQuoteHashes(quote: ExternalPaidJobFailureEvidence["quote"]): {
  requestHash: string
  responseHash: string
  negotiationHash: string
} {
  const requestHash = NegotiationRequest.fromDict(quote.request).computeHash()
  const responseHash = NegotiationResponse.fromDict(quote.response).computeHash()
  const content = buildDescriptionContent(quote, quote.chain_id, quote.verifying_contract)
  return { requestHash, responseHash, negotiationHash: keccak256(toBytes(canonicalJson(content))) }
}

export class ExternalPaidJobEvidenceError extends Error {
  readonly code: "SCHEMA_INVALID" | "INVARIANT_FAILED"

  constructor(code: ExternalPaidJobEvidenceError["code"], message: string) {
    super(message)
    this.name = "ExternalPaidJobEvidenceError"
    this.code = code
  }
}

export function verifyExternalPaidJobFailureEvidence(candidate: unknown): ExternalPaidJobFailureEvidence {
  const parsed = externalPaidJobFailureEvidenceSchema.safeParse(candidate)
  if (!parsed.success) fail("SCHEMA_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  const evidence = parsed.data
  verifyIdentity(evidence)
  verifyQuote(evidence)
  verifyLifecycle(evidence)
  verifyRefund(evidence)
  verifyLimitations(evidence)
  return evidence
}

export async function reverifyExternalPaidJobSignature(
  candidate: unknown,
): Promise<ExternalPaidJobSignatureVerification> {
  const evidence = verifyExternalPaidJobFailureEvidence(candidate)
  if (evidence.signature.method === "erc1271") {
    return { method: "erc1271", status: "CAPTURE_ONLY", signer: evidence.signature.signer }
  }
  let recovered: string
  try {
    recovered = await recoverMessageAddress({
      message: evidence.quote.negotiation_hash,
      signature: evidence.quote.provider_sig as `0x${string}`,
    })
  } catch {
    fail("INVARIANT_FAILED", "EIP-191 quote signature could not be recovered")
  }
  equalAddress(recovered, evidence.signature.signer, "EIP-191 quote signature recovered a different signer")
  return { method: "eip191", status: "OFFLINE_REVERIFIED", signer: recovered }
}

function verifyIdentity(evidence: ExternalPaidJobFailureEvidence): void {
  const { identity, network } = evidence
  equalAddress(identity.registry, network.contracts.registry, "registry does not match the network contract")
  equalAddress(identity.provider, identity.ownerObservedBeforeFunding, "provider was not the observed registry owner before funding")
  equalAddress(identity.provider, identity.ownerAtTerminal, "provider is not the registry owner at terminal capture")
  unequalAddress(identity.buyer, identity.provider, "buyer and provider must be separate")
  const sellers = identity.knotSellerAddresses.map(lower)
  const canonicalSellers = KNOT_TESTNET_SELLER_ADDRESSES.map(lower)
  invariant(new Set(sellers).size === 4, "KNOT seller addresses must be unique")
  invariant(sellers.every((seller) => canonicalSellers.includes(seller)), "KNOT seller addresses do not match the canonical testnet release set")
  invariant(canonicalSellers.every((seller) => sellers.includes(seller)), "KNOT seller addresses do not match the canonical testnet release set")
  invariant(!sellers.includes(lower(identity.provider)), "external provider matches a KNOT-operated seller")
  invariant(!sellers.includes(lower(identity.buyer)), "buyer matches a KNOT-operated seller")
  invariant(evidence.observations.registryNameMatchesCardName === (identity.name === evidence.observations.cardName), "registry/card name match flag is false")
  invariant(evidence.observations.selectedEndpointMatchesPublishedUrl === equivalentUrl(evidence.observations.endpoint, evidence.observations.publishedInvocationUrl), "selected/published endpoint match flag is false")
}

function verifyQuote(evidence: ExternalPaidJobFailureEvidence): void {
  const { quote, taskDescription, expectedPriceBaseUnits, network, safety, signature, transactions } = evidence
  invariant(quote.request.task_description === taskDescription, "quote task does not match the requested task")
  invariant(JSON.stringify(quote.request.terms) === JSON.stringify({
    deliverables: quote.response.terms.deliverables,
    quality_standards: quote.response.terms.quality_standards,
    evaluation_required: quote.response.terms.evaluation_required,
    evaluator_type: quote.response.terms.evaluator_type,
  }), "response terms changed the requested work")
  invariant(quote.response.terms.price === expectedPriceBaseUnits, "quote price does not match expected price")
  invariant(expectedPriceBaseUnits === safety.maximumServicePaymentBaseUnits, "price exceeds the safety cap")
  equalAddress(quote.response.terms.currency, network.contracts.paymentToken, "quote currency does not match payment token")
  equalAddress(safety.paymentToken, network.contracts.paymentToken, "safety token does not match payment token")
  equalAddress(quote.verifying_contract, network.contracts.commerce, "quote domain does not match commerce")
  equalAddress(signature.signer, evidence.identity.provider, "quote signer does not match provider")
  const hashes = deriveExternalPaidJobQuoteHashes(quote)
  invariant(lower(quote.request_hash) === lower(hashes.requestHash), "quote request hash does not match its content")
  invariant(lower(quote.response_hash) === lower(hashes.responseHash), "quote response hash does not match its content")
  invariant(lower(quote.negotiation_hash) === lower(hashes.negotiationHash), "quote negotiation hash does not match its signed content")
  invariant(quote.response.negotiated_at < quote.response.quote_expires_at, "quote timing is not ordered")
  invariant(BigInt(transactions.fund.timestamp) <= BigInt(quote.response.quote_expires_at), "quote expired before funding")
  invariant(evidence.onChainDescription === buildJobDescription(quote), "on-chain description does not bind the signed quote")
  if (signature.method === "eip191") {
    invariant(/^0x[0-9a-fA-F]{130}$/.test(quote.provider_sig), "EIP-191 quote signature is not 65 bytes")
  } else if (signature.historicalRecheck === "VERIFIED_AT_CAPTURE") {
    invariant(signature.historicalRecheckBlock === transactions.fund.blockNumber, "historical signature recheck is not anchored to the funding block")
    invariant(Date.parse(signature.historicalRecheckObservedAtUtc) >= Number(transactions.fund.timestamp) * 1_000, "historical signature recheck predates funding")
    invariant(Date.parse(evidence.capturedAtUtc) >= Date.parse(signature.historicalRecheckObservedAtUtc), "evidence capture predates the historical signature recheck")
  }
}

function verifyLifecycle(evidence: ExternalPaidJobFailureEvidence): void {
  const { transactions, events, lifecycle, identity, expectedPriceBaseUnits, preRefundObservation, notify } = evidence
  const names = ["create", "register", "approve", "setBudget", "fund", "refund", "markExpired"] as const
  const rows = names.map((name) => transactions[name])
  for (const [index, row] of rows.entries()) {
    invariant(new Date(Number(row.timestamp) * 1_000).toISOString() === row.timestampUtc, `${names[index]} timestamp forms disagree`)
    if (index > 0) invariant(BigInt(rows[index - 1]!.blockNumber) < BigInt(row.blockNumber), "transaction blocks are not strictly ordered")
  }
  invariant(BigInt(transactions.fund.timestamp) < BigInt(lifecycle.expiredAt), "job was not funded before expiry")
  invariant(BigInt(transactions.refund.timestamp) >= BigInt(lifecycle.expiredAt), "refund occurred before expiry")
  invariant(events.created[0]!.jobId === lifecycle.jobId && events.created[0]!.transactionHash === transactions.create.hash, "create event does not bind the job")
  invariant(events.registered[0]!.jobId === lifecycle.jobId && events.registered[0]!.transactionHash === transactions.register.hash, "register event does not bind the job")
  invariant(events.funded[0]!.jobId === lifecycle.jobId && events.funded[0]!.transactionHash === transactions.fund.hash, "fund event does not bind the job")
  invariant(events.finalised[0]!.jobId === lifecycle.jobId && events.finalised[0]!.transactionHash === transactions.markExpired.hash, "finalisation does not bind markExpired")
  invariant(events.created[0]!.blockNumber === transactions.create.blockNumber, "create event block does not match its receipt")
  invariant(events.registered[0]!.blockNumber === transactions.register.blockNumber, "register event block does not match its receipt")
  invariant(events.funded[0]!.blockNumber === transactions.fund.blockNumber, "fund event block does not match its receipt")
  invariant(events.finalised[0]!.blockNumber === transactions.markExpired.blockNumber, "finalisation block does not match markExpired")
  invariant(events.created[0]!.expiredAt === lifecycle.expiredAt, "created expiry does not match terminal job")
  invariant(events.funded[0]!.amount === expectedPriceBaseUnits, "funded amount does not match the quote")
  equalAddress(events.created[0]!.client, identity.buyer, "created client does not match buyer")
  equalAddress(events.created[0]!.provider, identity.provider, "created provider does not match external provider")
  equalAddress(events.created[0]!.evaluator, lifecycle.evaluator, "created evaluator does not match terminal job")
  equalAddress(events.registered[0]!.client, identity.buyer, "registered client does not match buyer")
  equalAddress(events.funded[0]!.client, identity.buyer, "funded client does not match buyer")
  equalAddress(events.funded[0]!.provider, identity.provider, "funded provider does not match external provider")
  invariant(lower(events.registered[0]!.policy) !== zeroAddress, "registered policy must be nonzero")
  equalAddress(lifecycle.client, identity.buyer, "terminal client does not match buyer")
  equalAddress(lifecycle.provider, identity.provider, "terminal provider does not match external provider")
  equalAddress(lifecycle.evaluator, evidence.network.contracts.router, "terminal evaluator does not match the router")
  equalAddress(lifecycle.hook, evidence.network.contracts.router, "terminal hook does not match the router")
  invariant(lifecycle.budgetBaseUnits === expectedPriceBaseUnits, "terminal budget does not match the quote")
  invariant(preRefundObservation.expiredAt === lifecycle.expiredAt && preRefundObservation.budgetBaseUnits === lifecycle.budgetBaseUnits, "pre-refund observation does not match the terminal job")
  equalAddress(preRefundObservation.client, lifecycle.client, "pre-refund client changed")
  equalAddress(preRefundObservation.provider, lifecycle.provider, "pre-refund provider changed")
  equalAddress(preRefundObservation.evaluator, lifecycle.evaluator, "pre-refund evaluator changed")
  equalAddress(preRefundObservation.hook, lifecycle.hook, "pre-refund hook changed")
  invariant(Date.parse(preRefundObservation.observedAtUtc) >= Number(lifecycle.expiredAt) * 1_000, "pre-refund observation occurred before expiry")
  invariant(Date.parse(preRefundObservation.observedAtUtc) <= Number(transactions.refund.timestamp) * 1_000, "pre-refund observation occurred after the refund")
  invariant(Date.parse(notify.observedAtUtc) >= Number(transactions.fund.timestamp) * 1_000, "seller acknowledgement predates funding")
  invariant(Date.parse(notify.observedAtUtc) < Number(lifecycle.expiredAt) * 1_000, "seller acknowledgement occurred after expiry")
  invariant(notify.result.job_id.toString() === lifecycle.jobId, "seller acknowledgement names a different job")
}

function verifyRefund(evidence: ExternalPaidJobFailureEvidence): void {
  const { refund, observations, expectedPriceBaseUnits, events, identity, network, transactions, capturedAtUtc } = evidence
  invariant(refund.refundedBaseUnits === expectedPriceBaseUnits, "refund does not equal the funded amount")
  invariant(BigInt(refund.balanceAfterBaseUnits) - BigInt(refund.balanceBeforeBaseUnits) === BigInt(refund.refundedBaseUnits), "buyer balance delta does not equal the refund")
  invariant(refund.balanceAfterBaseUnits === observations.initialBuyerBalanceBaseUnits, "refund did not restore the initial buyer balance")
  const transfer = events.refundTransfers[0]!
  invariant(transfer.transactionHash === transactions.refund.hash, "refund transfer does not match the refund transaction")
  invariant(transfer.blockNumber === transactions.refund.blockNumber, "refund transfer block does not match its receipt")
  equalAddress(transfer.from, network.contracts.commerce, "refund did not originate from commerce")
  equalAddress(transfer.to, identity.buyer, "refund did not return to the buyer")
  invariant(transfer.value === expectedPriceBaseUnits, "refund transfer amount does not match the funded amount")
  invariant(Date.parse(refund.observedAtUtc) >= Number(transactions.refund.timestamp) * 1_000, "refund observation predates its transaction")
  invariant(Date.parse(refund.reconciledAtUtc) >= Number(transactions.markExpired.timestamp) * 1_000, "router reconciliation predates markExpired")
  invariant(Date.parse(capturedAtUtc) >= Date.parse(refund.reconciledAtUtc), "capture predates reconciliation")
}

function verifyLimitations(evidence: ExternalPaidJobFailureEvidence): void {
  const text = evidence.limitations.join(" ")
  const signatureLimitation = evidence.signature.method === "eip191"
    ? /EIP-191.*signed negotiation hash/i
    : evidence.signature.historicalRecheck === "UNAVAILABLE"
      ? /pre-funding.*not historically rechecked/i
      : /historical.*verification.*point-in-time/i
  for (const pattern of [/no .*deliverable/i, /does not establish.*hireab/i, /testnet/i, /does not establish.*reliab/i, signatureLimitation, /ownership.*between.*observations/i]) {
    invariant(pattern.test(text), `required limitation is missing: ${pattern.source}`)
  }
  if (!evidence.observations.registryNameMatchesCardName) invariant(/registry name.*card name.*do not match/i.test(text), "registry/card name mismatch limitation is missing")
  if (!evidence.observations.selectedEndpointMatchesPublishedUrl) invariant(/published.*invocation URL.*does not match.*endpoint/i.test(text), "published invocation mismatch limitation is missing")
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) fail("INVARIANT_FAILED", message)
}

function equalAddress(left: string, right: string, message: string): void {
  invariant(lower(left) === lower(right), message)
}

function unequalAddress(left: string, right: string, message: string): void {
  invariant(lower(left) !== lower(right), message)
}

function lower(value: string): string {
  return value.toLowerCase()
}

function equivalentUrl(left: string, right: string): boolean {
  return new URL(left).href === new URL(right).href
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value)).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

function fail(code: ExternalPaidJobEvidenceError["code"], message: string): never {
  throw new ExternalPaidJobEvidenceError(code, message)
}
