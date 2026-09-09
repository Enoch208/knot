import { readFileSync } from "node:fs"
import { verifyTunnelRecoveryEvidence } from "../packages/reliability/src/tunnel-recovery.ts"

const evidencePath = process.argv[2] ?? ".secrets/reliability/tunnel-recovery-latest.json"
const evidence = verifyTunnelRecoveryEvidence(JSON.parse(readFileSync(evidencePath, "utf8")))

process.stdout.write(`${JSON.stringify({
  status: "VERIFIED_CONTROLLED_TUNNEL_RECOVERY",
  observedFromUtc: evidence.observedFromUtc,
  observedUntilUtc: evidence.observedUntilUtc,
  restartToCompletePublicRecoveryMs: evidence.timing.restartToCompletePublicRecoveryMs,
  recoveryProbeAttempts: evidence.drill.recoveryProbeAttempts,
  service: {
    unitId: evidence.serviceAfter.unitId,
    activeState: evidence.serviceAfter.activeState,
    subState: evidence.serviceAfter.subState,
    unitFileState: evidence.serviceAfter.unitFileState,
    restartPolicy: evidence.serviceAfter.restartPolicy,
    restartDelay: evidence.serviceAfter.restartDelay,
    invocationChanged: evidence.serviceBefore.invocationId !== evidence.serviceAfter.invocationId,
  },
  unchangedSellerContainers: evidence.containersAfter.map((container) => ({
    key: container.key,
    immutableImageId: container.immutableImageId,
    startedAtUtc: container.startedAtUtc,
  })),
  publicChecks: {
    apiAndDatabaseAvailable: true,
    sellerCards: 4,
    registrationProofs: 4,
    unauthenticatedInvocationStatus: 401,
    retainedArtifactSha256: evidence.publicAfter.retainedArtifact.response.sha256,
  },
  boundary: evidence.boundary,
  limitations: evidence.limitations,
}, null, 2)}\n`)
