import { readFileSync } from "node:fs"
import { reverifyExternalPaidJobSignature, verifyExternalPaidJobFailureEvidence } from "../packages/evidence/src/index.ts"

const evidencePath = process.argv[2] ?? "evidence/testnet/external-paid-job-1191.json"
const evidence = verifyExternalPaidJobFailureEvidence(JSON.parse(readFileSync(evidencePath, "utf8")))
const signatureVerification = await reverifyExternalPaidJobSignature(evidence)
process.stdout.write(`${JSON.stringify({
  status: "STRUCTURALLY_VERIFIED_FAILURE_EVIDENCE",
  jobId: evidence.lifecycle.jobId,
  outcome: evidence.outcome,
  provider: evidence.identity.provider,
  buyer: evidence.identity.buyer,
  fundedBaseUnits: evidence.lifecycle.budgetBaseUnits,
  refundedBaseUnits: evidence.refund.refundedBaseUnits,
  terminalStatus: evidence.lifecycle.terminalStatus,
  routerReconciled: true,
  liveChainChecked: false,
  signatureVerification,
  historicalErc1271Evidence: evidence.signature.method === "erc1271" ? evidence.signature.historicalRecheck : "NOT_APPLICABLE",
  historicalErc1271VerifiedAtCapture: evidence.signature.method === "erc1271" && evidence.signature.historicalRecheck === "VERIFIED_AT_CAPTURE",
  historicalErc1271Rechecked: false,
}, null, 2)}\n`)
