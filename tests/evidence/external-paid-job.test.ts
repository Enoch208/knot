import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { buildJobDescription } from "@bnbagent/sdk/erc8183"
import {
  ExternalPaidJobEvidenceError,
  KNOT_TESTNET_SELLER_ADDRESSES,
  type ExternalPaidJobFailureEvidence,
  deriveExternalPaidJobQuoteHashes,
  reverifyExternalPaidJobSignature,
  verifyExternalPaidJobFailureEvidence,
} from "../../packages/evidence/src/index.ts"

const buyer = "0x1111111111111111111111111111111111111111"
const provider = "0x2222222222222222222222222222222222222222"
const commerce = "0x3333333333333333333333333333333333333333"
const router = "0x4444444444444444444444444444444444444444"
const registry = "0x5555555555555555555555555555555555555555"
const token = "0x6666666666666666666666666666666666666666"
const policy = "0x7777777777777777777777777777777777777777"
const evaluator = router
const zeroAddress = "0x0000000000000000000000000000000000000000"
const zeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000" as const

function fixture(): ExternalPaidJobFailureEvidence {
  const taskDescription = "Produce one read-only BNB/USDT grid plan with no transaction execution."
  const requestTerms = {
    deliverables: "One structured read-only grid analysis artifact.",
    quality_standards: "State sources, units, constraints, and limitations.",
    evaluation_required: true as const,
    evaluator_type: "uma_oov3",
  }
  const quote: ExternalPaidJobFailureEvidence["quote"] = {
    request: { task_description: taskDescription, terms: requestTerms },
    request_hash: zeroHash,
    response: {
      accepted: true as const,
      terms: { ...requestTerms, price: "100", currency: token },
      estimated_completion_seconds: 60,
      quote_expires_at: 1_000,
      negotiated_at: 100,
    },
    response_hash: zeroHash,
    negotiation_hash: zeroHash,
    provider_sig: "0x01",
    chain_id: 97 as const,
    verifying_contract: commerce,
  }
  const quoteHashes = deriveExternalPaidJobQuoteHashes(quote)
  quote.request_hash = quoteHashes.requestHash
  quote.response_hash = quoteHashes.responseHash
  quote.negotiation_hash = quoteHashes.negotiationHash
  const transactions = {
    create: transaction(10, 200),
    register: transaction(11, 300),
    approve: transaction(12, 350),
    setBudget: transaction(13, 400),
    fund: transaction(14, 500),
    refund: transaction(15, 700),
    markExpired: transaction(16, 710),
  }
  return {
    schemaVersion: "knot.external-paid-job-failure/1",
    capturedAtUtc: iso(720),
    outcome: { classification: "FAILURE", reason: "EXPIRED_WITHOUT_DELIVERY", deliveryReceived: false, providerPaymentBaseUnits: "0" },
    network: {
      name: "BSC testnet",
      chainId: 97,
      realFunds: false,
      mainnetWrites: false,
      contracts: { commerce, router, registry, paymentToken: token },
    },
    identity: {
      registry,
      agentId: "2159",
      name: "External Grid Seller",
      provider,
      ownerObservedBeforeFunding: provider,
      ownerAtTerminal: provider,
      buyer,
      knotSellerAddresses: [...KNOT_TESTNET_SELLER_ADDRESSES],
    },
    operatorRelationship: "external_distinct_owner",
    taskDescription,
    quote,
    signature: {
      valid: true,
      method: "erc1271",
      signer: provider,
      verificationBasis: "live-pre-funding",
      historicalRecheck: "UNAVAILABLE",
      historicalRecheckReason: "public RPC historical state pruned",
    },
    safety: {
      mainnetWritesAuthorized: false,
      executionAuthorized: false,
      maximumServicePaymentBaseUnits: "100",
      paymentNetwork: "BSC testnet",
      paymentToken: token,
    },
    observations: {
      cardUrl: "https://external.example/.well-known/agent-card.json",
      endpoint: "https://external.example/apex",
      cardName: "External Grid Seller",
      publishedInvocationUrl: "https://external.example/apex",
      registryNameMatchesCardName: true,
      selectedEndpointMatchesPublishedUrl: true,
      cardObservedAtUtc: iso(90),
      initialAllowanceBaseUnits: "0",
      initialBuyerBalanceBaseUnits: "1000",
    },
    onChainDescription: buildJobDescription(quote),
    transactions,
    events: {
      created: [{ jobId: "1191", client: buyer, provider, evaluator, expiredAt: "600", blockNumber: "10", transactionHash: transactions.create.hash }],
      registered: [{ jobId: "1191", policy, client: buyer, blockNumber: "11", transactionHash: transactions.register.hash }],
      funded: [{ jobId: "1191", client: buyer, provider, amount: "100", blockNumber: "14", transactionHash: transactions.fund.hash }],
      submitted: [],
      finalised: [{ jobId: "1191", status: 5, blockNumber: "16", transactionHash: transactions.markExpired.hash }],
      refundTransfers: [{ blockNumber: "15", transactionHash: transactions.refund.hash, from: commerce, to: buyer, value: "100" }],
    },
    lifecycle: {
      jobId: "1191",
      expiredAt: "600",
      terminalStatus: "EXPIRED",
      terminalStatusCode: 5,
      client: buyer,
      provider,
      evaluator,
      hook: evaluator,
      budgetBaseUnits: "100",
      deliverableHash: zeroHash,
      submittedAt: "0",
      deliverableUrl: null,
      policy: zeroAddress,
      disputeWindowSeconds: "50",
      policySubmittedAt: "0",
      disputed: false,
      inflightJobCountAfterReconciliation: "364",
    },
    notify: { observedAtUtc: iso(510), result: { status: "accepted", job_id: 1191, note: "delivery started" } },
    preRefundObservation: {
      observedAtUtc: iso(650),
      status: 1,
      client: buyer,
      provider,
      evaluator,
      hook: evaluator,
      budgetBaseUnits: "100",
      expiredAt: "600",
      deliverableHash: zeroHash,
      submittedAt: "0",
      deliverableUrl: null,
    },
    refund: {
      observedAtUtc: iso(705),
      balanceBeforeBaseUnits: "900",
      balanceAfterBaseUnits: "1000",
      refundedBaseUnits: "100",
      terminalStatus: "EXPIRED",
      reconciledAtUtc: iso(715),
    },
    expectedPriceBaseUnits: "100",
    limitations: [
      "No deliverable was submitted or received.",
      "This failed observation does not establish external seller hireability.",
      "All value was testnet-only and was not real revenue.",
      "One observation does not establish seller reliability.",
      "ERC-1271 authorization was captured live pre-funding and not historically rechecked because public RPC state was pruned.",
      "Registry ownership could theoretically change between observations.",
    ],
  }
}

test("verifies an honest expired and fully refunded external paid job", () => {
  const evidence = verifyExternalPaidJobFailureEvidence(fixture())
  assert.equal(evidence.outcome.classification, "FAILURE")
  assert.equal(evidence.lifecycle.terminalStatus, "EXPIRED")
  assert.equal(evidence.events.submitted.length, 0)
  assert.equal(evidence.refund.refundedBaseUnits, evidence.expectedPriceBaseUnits)
})

test("verifies all three preserved external failure records", () => {
  const firstRaw = readFileSync("evidence/testnet/external-paid-job-1191.json", "utf8")
  const secondRaw = readFileSync("evidence/testnet/external-paid-job-1198.json", "utf8")
  const thirdRaw = readFileSync("evidence/testnet/external-paid-job-1203.json", "utf8")
  const first = verifyExternalPaidJobFailureEvidence(JSON.parse(firstRaw))
  const second = verifyExternalPaidJobFailureEvidence(JSON.parse(secondRaw))
  const third = verifyExternalPaidJobFailureEvidence(JSON.parse(thirdRaw))
  assert.equal(first.lifecycle.jobId, "1191")
  assert.equal(first.signature.historicalRecheck, "UNAVAILABLE")
  assert.equal(second.lifecycle.jobId, "1198")
  assert.equal(second.signature.historicalRecheck, "VERIFIED_AT_CAPTURE")
  assert.equal(second.observations.registryNameMatchesCardName, false)
  assert.equal(second.observations.selectedEndpointMatchesPublishedUrl, false)
  assert.equal(third.lifecycle.jobId, "1203")
  assert.equal(third.signature.method, "eip191")
  assert.equal(third.signature.historicalRecheck, "NOT_APPLICABLE")
  assert.equal(third.observations.registryNameMatchesCardName, true)
  assert.equal(third.observations.selectedEndpointMatchesPublishedUrl, true)
  assert.doesNotMatch(`${firstRaw}${secondRaw}${thirdRaw}`, /sk-proj-|private[_ -]?key|mnemonic|seed phrase|bearer\s+[a-z0-9._-]+|api[_ -]?key/i)
})

test("reverifies the job 1203 EIP-191 quote signer without chain state", async () => {
  const source = JSON.parse(readFileSync("evidence/testnet/external-paid-job-1203.json", "utf8"))
  const verified = await reverifyExternalPaidJobSignature(source)
  assert.deepEqual(verified, {
    method: "eip191",
    status: "OFFLINE_REVERIFIED",
    signer: "0xB01eeF1075e5a5218bE7d6BC2C7E67FBeb723553",
  })

  const tampered = structuredClone(source) as unknown
  assertObject(tampered)
  assertObject(tampered.quote)
  tampered.quote.provider_sig = `0x${"0".repeat(130)}`
  await assert.rejects(() => reverifyExternalPaidJobSignature(tampered), ExternalPaidJobEvidenceError)
})

test("rejects buyer-provider and KNOT-operator overlap", () => {
  const sameParty = fixture()
  sameParty.identity.buyer = provider
  rejectsInvariant(sameParty, /buyer and provider/)

  const invented = fixture()
  invented.identity.knotSellerAddresses = [address(10), address(11), address(12), address(13)]
  rejectsInvariant(invented, /canonical testnet release set/)

  const operated = fixture()
  const knotProvider = KNOT_TESTNET_SELLER_ADDRESSES[0]
  operated.identity.provider = knotProvider
  operated.identity.ownerObservedBeforeFunding = knotProvider
  operated.identity.ownerAtTerminal = knotProvider
  operated.signature.signer = knotProvider
  operated.events.created[0]!.provider = knotProvider
  operated.events.funded[0]!.provider = knotProvider
  operated.lifecycle.provider = knotProvider
  operated.preRefundObservation.provider = knotProvider
  rejectsInvariant(operated, /external provider matches/)
})

test("binds discovery mismatch flags and requires mismatch limitations", () => {
  const falseNameFlag = fixture()
  falseNameFlag.observations.registryNameMatchesCardName = false
  rejectsInvariant(falseNameFlag, /registry\/card name match flag/)

  const falseEndpointFlag = fixture()
  falseEndpointFlag.observations.selectedEndpointMatchesPublishedUrl = false
  rejectsInvariant(falseEndpointFlag, /selected\/published endpoint match flag/)

  const mismatch = fixture()
  mismatch.observations.cardName = "Different Card Name"
  mismatch.observations.registryNameMatchesCardName = false
  rejectsInvariant(mismatch, /registry\/card name mismatch limitation/)

  mismatch.limitations.push("The registry name and card name do not match.")
  mismatch.observations.publishedInvocationUrl = "http://localhost:8080/"
  mismatch.observations.selectedEndpointMatchesPublishedUrl = false
  rejectsInvariant(mismatch, /published invocation mismatch limitation/)

  mismatch.limitations.push("The published invocation URL does not match the selected endpoint.")
  assert.equal(verifyExternalPaidJobFailureEvidence(mismatch).observations.cardName, "Different Card Name")
})

test("rejects quote task, domain, token, price, and expiry drift", () => {
  const task = fixture()
  task.quote.request.task_description = "Different task"
  rejectsInvariant(task, /quote task/)

  const domain = fixture()
  domain.quote.verifying_contract = address(99)
  rejectsInvariant(domain, /quote domain/)

  const paymentToken = fixture()
  paymentToken.quote.response.terms.currency = address(98)
  rejectsInvariant(paymentToken, /quote currency/)

  const price = fixture()
  price.quote.response.terms.price = "101"
  rejectsInvariant(price, /quote price/)

  const expiry = fixture()
  expiry.quote.response.quote_expires_at = 499
  rebindQuote(expiry)
  rejectsInvariant(expiry, /expired before funding/)
})

test("binds a successful historical signature recheck to the funding block", () => {
  const evidence = fixture()
  evidence.signature = {
    valid: true,
    method: "erc1271",
    signer: provider,
    verificationBasis: "live-pre-funding",
    historicalRecheck: "VERIFIED_AT_CAPTURE",
    historicalRecheckBlock: evidence.transactions.fund.blockNumber,
    historicalRecheckObservedAtUtc: iso(520),
  }
  evidence.limitations = evidence.limitations.map((item) => item.includes("not historically rechecked")
    ? "Historical signature verification is one point-in-time public RPC observation."
    : item)
  assert.equal(verifyExternalPaidJobFailureEvidence(evidence).signature.historicalRecheck, "VERIFIED_AT_CAPTURE")

  evidence.signature.historicalRecheckBlock = evidence.transactions.create.blockNumber
  rejectsInvariant(evidence, /funding block/)

  evidence.signature.historicalRecheckBlock = evidence.transactions.fund.blockNumber
  evidence.capturedAtUtc = iso(519)
  rejectsInvariant(evidence, /capture predates/)
})

test("rejects failed, reordered, and mismatched lifecycle transactions", () => {
  const failed = structuredClone(fixture()) as unknown
  assertObject(failed)
  assertObject(failed.transactions)
  assertObject(failed.transactions.fund)
  failed.transactions.fund.status = "reverted"
  rejectsSchema(failed)

  const reordered = fixture()
  reordered.transactions.refund.blockNumber = reordered.transactions.fund.blockNumber
  rejectsInvariant(reordered, /strictly ordered/)

  const finalised = fixture()
  finalised.events.finalised[0]!.transactionHash = hash(99)
  rejectsInvariant(finalised, /finalisation/)
})

test("rejects router binding and lifecycle timing drift", () => {
  const routerBinding = fixture()
  routerBinding.lifecycle.hook = address(99)
  rejectsInvariant(routerBinding, /hook does not match the router/)

  const earlyObservation = fixture()
  earlyObservation.preRefundObservation.observedAtUtc = iso(599)
  rejectsInvariant(earlyObservation, /before expiry/)

  const lateObservation = fixture()
  lateObservation.preRefundObservation.observedAtUtc = iso(701)
  rejectsInvariant(lateObservation, /after the refund/)

  const earlyNotify = fixture()
  earlyNotify.notify.observedAtUtc = iso(499)
  rejectsInvariant(earlyNotify, /predates funding/)

  const lateNotify = fixture()
  lateNotify.notify.observedAtUtc = iso(600)
  rejectsInvariant(lateNotify, /after expiry/)
})

test("rejects delivery evidence in an expired-without-delivery record", () => {
  const submitted = structuredClone(fixture()) as unknown
  assertObject(submitted)
  assertObject(submitted.events)
  submitted.events.submitted = [{ jobId: "1191" }]
  rejectsSchema(submitted)

  const delivered = structuredClone(fixture()) as unknown
  assertObject(delivered)
  assertObject(delivered.lifecycle)
  delivered.lifecycle.deliverableHash = hash(77)
  rejectsSchema(delivered)
})

test("rejects partial refund, wrong recipient, and missing balance restoration", () => {
  const amount = fixture()
  amount.refund.refundedBaseUnits = "99"
  rejectsInvariant(amount, /funded amount/)

  const recipient = fixture()
  recipient.events.refundTransfers[0]!.to = address(99)
  rejectsInvariant(recipient, /return to the buyer/)

  const restoration = fixture()
  restoration.refund.balanceAfterBaseUnits = "999"
  rejectsInvariant(restoration, /balance delta/)
})

test("rejects unreconciled router or weakened limitations", () => {
  const policyNotCleared = structuredClone(fixture()) as unknown
  assertObject(policyNotCleared)
  assertObject(policyNotCleared.lifecycle)
  policyNotCleared.lifecycle.policy = policy
  rejectsSchema(policyNotCleared)

  const noFinalisation = structuredClone(fixture()) as unknown
  assertObject(noFinalisation)
  assertObject(noFinalisation.events)
  noFinalisation.events.finalised = []
  rejectsSchema(noFinalisation)

  const limitations = fixture()
  limitations.limitations = ["No deliverable was received.", "Testnet only.", "Not reliable.", "Not hireable."]
  rejectsInvariant(limitations, /required limitation/)
})

function transaction(block: number, timestamp: number) {
  return {
    hash: hash(block),
    status: "success" as const,
    blockNumber: block.toString(),
    blockHash: hash(block + 1_000),
    timestamp: timestamp.toString(),
    timestampUtc: iso(timestamp),
    gasUsed: "1",
    effectiveGasPriceWei: "0",
  }
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`
}

function address(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(40, "0")}`
}

function iso(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString()
}

function rebindQuote(evidence: ExternalPaidJobFailureEvidence): void {
  const hashes = deriveExternalPaidJobQuoteHashes(evidence.quote)
  evidence.quote.request_hash = hashes.requestHash
  evidence.quote.response_hash = hashes.responseHash
  evidence.quote.negotiation_hash = hashes.negotiationHash
  evidence.onChainDescription = buildJobDescription(evidence.quote)
}

function rejectsInvariant(candidate: unknown, message: RegExp): void {
  assert.throws(() => verifyExternalPaidJobFailureEvidence(candidate), (error: unknown) => {
    assert.ok(error instanceof ExternalPaidJobEvidenceError)
    assert.equal(error.code, "INVARIANT_FAILED")
    assert.match(error.message, message)
    return true
  })
}

function rejectsSchema(candidate: unknown): void {
  assert.throws(() => verifyExternalPaidJobFailureEvidence(candidate), (error: unknown) => {
    assert.ok(error instanceof ExternalPaidJobEvidenceError)
    assert.equal(error.code, "SCHEMA_INVALID")
    return true
  })
}

type JsonObject = Record<string, unknown>

function assertObject(value: unknown): asserts value is JsonObject {
  assert.equal(typeof value, "object")
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}
