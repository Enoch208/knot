import { readFileSync } from "node:fs"
import { verifySellerRecoveryEvidence } from "../packages/reliability/src/seller-recovery.ts"

const evidencePath = process.argv[2] ?? "evidence/operations/seller-recovery-20260909.json"
const evidence = verifySellerRecoveryEvidence(JSON.parse(readFileSync(evidencePath, "utf8")))
const durations = evidence.sellers.map((seller) => seller.timing.recoveryDurationMs)
process.stdout.write(`${JSON.stringify({
  status: "VERIFIED",
  observedAtUtc: evidence.observedAtUtc,
  sellers: evidence.sellers.map((seller) => ({
    key: seller.key,
    recoveryDurationMs: seller.timing.recoveryDurationMs,
    imageUnchanged: seller.image.unchanged,
    artifactSha256: seller.publicSurfaceAfter.retainedArtifact.sha256,
  })),
  maximumRecoveryDurationMs: Math.max(...durations),
  boundary: evidence.boundary,
}, null, 2)}\n`)
