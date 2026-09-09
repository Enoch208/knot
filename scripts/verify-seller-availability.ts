import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readAndVerifyClaimLedger } from "../packages/evidence/src/index.ts"
import { verifySellerAvailabilityEvidence, verifySellerAvailabilityPublicationBindings } from "../packages/reliability/src/seller-availability.ts"

const evidencePath = process.argv[2] ?? "evidence/operations/seller-availability-20260909.json"
const evidenceInput: unknown = JSON.parse(readFileSync(evidencePath, "utf8"))
const evidence = verifySellerAvailabilityEvidence(evidenceInput)
const repositoryRoot = resolve(import.meta.dirname, "..")
const ledger = readAndVerifyClaimLedger(resolve(repositoryRoot, "evidence/claims.json"), repositoryRoot)
const claim = ledger.claims.find((item) => item.id === "seller-short-availability-observation")
if (claim === undefined) throw new Error("availability claim is missing")
const summary = verifySellerAvailabilityPublicationBindings(evidenceInput, claim, readFileSync(resolve(repositoryRoot, "README.md"), "utf8"))
const sellers = evidence.rounds[0]!.sellers.map((identity) => {
  const latencies = evidence.rounds.flatMap((round) => {
    const observed = round.sellers.find((item) => item.key === identity.key)!
    return Object.values(observed.requests).map((request) => request.latencyMs)
  })
  return {
    key: identity.key,
    samples: evidence.rounds.length,
    matchedResponses: latencies.length,
    minimumLatencyMs: Math.min(...latencies),
    maximumLatencyMs: Math.max(...latencies),
  }
})

process.stdout.write(`${JSON.stringify({
  status: "VERIFIED",
  observationWindow: { fromUtc: evidence.observedFromUtc, toUtc: evidence.observedUntilUtc },
  observationDurationMs: evidence.observationDurationMs,
  sellerCount: sellers.length,
  totalSamples: evidence.rounds.length * sellers.length,
  totalMatchedResponses: summary.matchedResponseCount,
  capturedBodyCount: evidence.capturedBodies.length,
  sellers,
  boundary: evidence.boundary,
  limitations: evidence.limitations,
}, null, 2)}\n`)
