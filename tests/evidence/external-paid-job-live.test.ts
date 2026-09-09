import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  ExternalPaidJobLiveEvidenceError,
  type ExternalPaidJobLiveObservation,
  externalPaidJobTransactionNames,
  verifyExternalPaidJobFailureEvidence,
  verifyExternalPaidJobLiveObservation,
} from "../../packages/evidence/src/index.ts"

const evidence = verifyExternalPaidJobFailureEvidence(JSON.parse(readFileSync("evidence/testnet/external-paid-job-1191.json", "utf8")))

function observation(): ExternalPaidJobLiveObservation {
  const targets = {
    create: evidence.network.contracts.commerce,
    register: evidence.network.contracts.router,
    approve: evidence.network.contracts.paymentToken,
    setBudget: evidence.network.contracts.commerce,
    fund: evidence.network.contracts.commerce,
    refund: evidence.network.contracts.commerce,
    markExpired: evidence.network.contracts.router,
  }
  const receipts = {} as ExternalPaidJobLiveObservation["receipts"]
  for (const name of externalPaidJobTransactionNames) {
    const transaction = evidence.transactions[name]
    receipts[name] = {
      transactionHash: transaction.hash,
      status: transaction.status,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      timestamp: transaction.timestamp,
      gasUsed: transaction.gasUsed,
      effectiveGasPriceWei: transaction.effectiveGasPriceWei,
      to: targets[name],
    }
  }
  return {
    chainId: evidence.network.chainId,
    observedAtUtc: "2026-09-09T16:00:00.000Z",
    receipts,
    owner: evidence.identity.provider,
    paymentToken: evidence.network.contracts.paymentToken,
    jobPolicy: evidence.lifecycle.policy,
    job: {
      id: evidence.lifecycle.jobId,
      client: evidence.lifecycle.client,
      provider: evidence.lifecycle.provider,
      evaluator: evidence.lifecycle.evaluator,
      description: evidence.onChainDescription,
      budget: evidence.lifecycle.budgetBaseUnits,
      expiredAt: evidence.lifecycle.expiredAt,
      status: evidence.lifecycle.terminalStatusCode,
      hook: evidence.lifecycle.hook,
      deliverable: evidence.lifecycle.deliverableHash,
      submittedAt: evidence.lifecycle.submittedAt,
    },
    events: {
      created: structuredClone(evidence.events.created),
      registered: structuredClone(evidence.events.registered),
      funded: structuredClone(evidence.events.funded),
      finalised: structuredClone(evidence.events.finalised),
      refundTransfers: structuredClone(evidence.events.refundTransfers),
    },
  }
}

test("verifies public receipts, events, owner, and terminal job state", () => {
  const result = verifyExternalPaidJobLiveObservation(evidence, observation())
  assert.equal(result.status, "LIVE_CHAIN_VERIFIED_FAILURE")
  assert.equal(result.receiptCount, 7)
  assert.equal(result.eventCount, 5)
  assert.equal(result.historicalErc1271Recheck, "NOT_PERFORMED")
  assert.equal(result.historicalErc1271EvidenceStatus, "UNAVAILABLE")
  assert.equal(result.historicalErc1271RecheckReason, "public RPC historical state pruned")
})

test("rejects a fictitious transaction receipt or wrong contract target", () => {
  const receipt = observation()
  receipt.receipts.fund.blockHash = hash(99)
  rejectsLive(receipt, /fund receipt block hash/)

  const target = observation()
  target.receipts.approve.to = address(99)
  rejectsLive(target, /approve transaction reached/)
})

test("rejects tampered events", () => {
  const candidate = observation()
  candidate.events.refundTransfers[0]!.value = "1"
  rejectsLive(candidate, /refundTransfers live events/)
})

test("rejects non-terminal current state and registry owner drift", () => {
  const state = observation()
  state.job.status = 1
  rejectsLive(state, /not terminal EXPIRED/)

  const owner = observation()
  owner.owner = address(99)
  rejectsLive(owner, /current ERC-8004 owner/)
})

function rejectsLive(observed: ExternalPaidJobLiveObservation, message: RegExp): void {
  assert.throws(() => verifyExternalPaidJobLiveObservation(evidence, observed), (error: unknown) => {
    assert.ok(error instanceof ExternalPaidJobLiveEvidenceError)
    assert.match(error.message, message)
    return true
  })
}

function hash(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`
}

function address(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(40, "0")}`
}
