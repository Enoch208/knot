import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { GridQuantIndependentEvaluator } from "../../packages/advantage/src/gridquant.ts"
import { AdvantageValidationError, validateExperimentDataset } from "../../packages/advantage/src/runner.ts"

const datasetPath = resolve("evidence/advantage/gridquant-1187/dataset.json")
const evidenceRoot = dirname(datasetPath)
const evaluator = new GridQuantIndependentEvaluator()

test("GridQuant job 1187 is independently reproducible from paid and replay evidence", async () => {
  const dataset = await verifyDataset()
  const experiment = dataset.experiments[0]
  assert.equal(dataset.experiments.length, 1)
  assert.equal(experiment?.experimentId, "gridquant-1187")
  assert.equal(experiment?.agentPath.observation.durationMs, 93_618)
  assert.equal(experiment?.agentPath.rawOutput.evidenceClass, "testnet_observation")
  assert.equal(experiment?.baselinePath.rawOutput.evidenceClass, "historical_replay")
  assert.equal(experiment?.baselinePath.costs[0]?.amount.units, "650000")
  assert.equal(experiment?.baselinePath.costs[0]?.amount.symbol, "ns")
  assert.deepEqual(experiment?.comparison, {
    winner: "tie",
    agentWins: 0,
    baselineWins: 0,
    ties: 5,
    decisiveDimensionId: null,
  })
  assert.equal(experiment?.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000), true)
})

test("GridQuant job 1187 retains the exact signed task, paid terminal state, and public manifest", async () => {
  const [requestBytes, taskBytes, negotiationBytes, manifestBytes, proofBytes, consolidatedBytes] = await Promise.all([
    readFile(resolve(evidenceRoot, "input.json")),
    readFile(resolve(evidenceRoot, "task.json")),
    readFile(resolve(evidenceRoot, "agent-negotiate-observation.json")),
    readFile(resolve(evidenceRoot, "agent-manifest.json")),
    readFile(resolve(evidenceRoot, "job-1187.json")),
    readFile(resolve("evidence/testnet/analysis-paid-jobs-1187-1189.json")),
  ])
  const negotiation = JSON.parse(negotiationBytes.toString("utf8")) as NegotiationObservation
  const proof = JSON.parse(proofBytes.toString("utf8")) as JobProof
  const consolidated = JSON.parse(consolidatedBytes.toString("utf8")) as ConsolidatedEvidence
  const description = negotiation.request.params.message.parts[0]?.data.task_description ?? ""
  assert.ok(description.startsWith("knot-json-deflate-base64url/1:"))
  const encoded = description.slice("knot-json-deflate-base64url/1:".length)
  assert.deepEqual(inflateRawSync(Buffer.from(encoded, "base64url")), requestBytes)
  assert.equal(negotiation.response.result.parts[0]?.data.provider_sig.length, 132)
  assert.equal(createHash("sha256").update(requestBytes).digest("hex"), "a5080988db61ec66269eecc135c869bf827020bccee616e127d6c50d38209980")
  assert.equal(createHash("sha256").update(taskBytes).digest("hex"), "33a611544787e151a05049cf6aa3cb3fb73ed3f6fdb4c330727487cab55c21b4")
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), proof.deliverable.rawSha256)
  assert.equal(proof.deliverable.rawSha256, "0a8f485757cdc3308e95e944362e2be73d966b2a7309da437abc8f9e04adf152")
  assert.equal(proof.job.status, 3)
  assert.equal(proof.transactions.settle.paymentTransfer.amountBaseUnits, "100000000000000000")
  assert.equal(proof.transactions.settle.receiptStatus, "success")
  const retained = consolidated.jobs.find((job) => job.jobId === "1187")
  assert.ok(retained)
  assert.equal(retained.terminalStatus, "COMPLETED")
  assert.equal(retained.deliverable.rawSha256, proof.deliverable.rawSha256)
  assert.equal(retained.taskBinding.inputHash, proof.task.inputHash)
  assert.doesNotMatch(Buffer.concat([requestBytes, taskBytes, negotiationBytes, manifestBytes, proofBytes]).toString("utf8"), /client_secret|access_token|password|private.?key|sk-proj/i)
})

test("GridQuant job 1187 evidence fails closed when artifact bytes or the winner are changed", async () => {
  const source = JSON.parse(await readFile(datasetPath, "utf8")) as DatasetRecord
  const changedArtifact = Buffer.from(await readFile(resolve(evidenceRoot, "baseline-artifact.json")))
  changedArtifact[changedArtifact.length - 2] = changedArtifact[changedArtifact.length - 2] === 32 ? 33 : 32
  await assert.rejects(
    validateExperimentDataset(source, async (reference) => reference.uri === "baseline-artifact.json" ? changedArtifact : readFile(resolve(evidenceRoot, reference.uri)), [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
  const changedWinner = structuredClone(source)
  const first = changedWinner.experiments[0]
  assert.ok(first)
  first.comparison = { winner: "agent", agentWins: 1, baselineWins: 0, ties: 4, decisiveDimensionId: "contract_integrity" }
  await assert.rejects(
    validateExperimentDataset(changedWinner, async (reference) => readFile(resolve(evidenceRoot, reference.uri)), [evaluator]),
  )
})

test("GridQuant job 1187 replay remains bound to the recorded independent implementation", async () => {
  const method = JSON.parse(await readFile(resolve(evidenceRoot, "baseline-method.json"), "utf8")) as BaselineMethod
  for (const implementation of method.implementation) {
    const source = await readFile(resolve(implementation.path))
    assert.equal(createHash("sha256").update(source).digest("hex"), implementation.sha256)
  }
  assert.equal(method.evidenceBoundary.agent, "testnet_observation")
  assert.equal(method.evidenceBoundary.baseline, "historical_replay")
  assert.equal(method.limitations.some((value) => value.includes("not contemporaneous or live")), true)
  assert.equal(method.limitations.some((value) => value.includes("no performance, PnL, or future-return claim")), true)
})

async function verifyDataset() {
  return validateExperimentDataset(
    JSON.parse(await readFile(datasetPath, "utf8")) as unknown,
    async (reference) => readFile(resolve(evidenceRoot, reference.uri)),
    [evaluator],
  )
}

interface NegotiationObservation {
  request: { params: { message: { parts: Array<{ data: { task_description?: string } }> } } }
  response: { result: { parts: Array<{ data: { provider_sig: string } }> } }
}

interface JobProof {
  job: { status: number }
  task: { inputHash: string }
  transactions: { settle: { receiptStatus: string; paymentTransfer: { amountBaseUnits: string } } }
  deliverable: { rawSha256: string }
}

interface ConsolidatedEvidence {
  jobs: Array<{ jobId: string; terminalStatus: string; taskBinding: { inputHash: string }; deliverable: { rawSha256: string } }>
}

interface DatasetRecord {
  experiments: Array<{ comparison: { winner: string; agentWins: number; baselineWins: number; ties: number; decisiveDimensionId: string | null } }>
}

interface BaselineMethod {
  implementation: Array<{ path: string; sha256: string }>
  evidenceBoundary: { agent: string; baseline: string }
  limitations: string[]
}
