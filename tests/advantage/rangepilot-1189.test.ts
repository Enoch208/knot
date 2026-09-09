import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { inflateRawSync } from "node:zlib"
import { JobDescription } from "@bnbagent/sdk/erc8183"
import { keccak256, recoverMessageAddress, toHex, type Hex } from "viem"
import { RangePilotIndependentEvaluator } from "../../packages/advantage/src/rangepilot.ts"
import { AdvantageValidationError, validateExperimentDataset } from "../../packages/advantage/src/runner.ts"
import type { ExperimentDataset } from "../../packages/advantage/src/schemas.ts"

const datasetPath = resolve("evidence/advantage/rangepilot-1189/dataset.json")
const evidenceRoot = dirname(datasetPath)
const evaluator = new RangePilotIndependentEvaluator()

test("paid RangePilot job 1189 and its historical replay are independently reproducible", async () => {
  const dataset = await verifiedDataset()
  const experiment = dataset.experiments[0]
  assert.equal(dataset.experiments.length, 1)
  assert.equal(experiment?.experimentId, "rangepilot-1189")
  assert.deepEqual(experiment?.comparison, {
    winner: "tie",
    agentWins: 0,
    baselineWins: 0,
    ties: 6,
    decisiveDimensionId: null,
  })
  assert.ok(experiment?.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000))
  assert.equal(experiment?.agentPath.rawOutput.evidenceClass, "testnet_observation")
  assert.equal(experiment?.baselinePath.implementation.evidenceClass, "historical_replay")
  assert.equal(experiment?.baselinePath.rawOutput.evidenceClass, "historical_replay")
  assert.equal(experiment?.baselinePath.artifact.evidenceClass, "historical_replay")
  assert.equal(experiment?.agentPath.observation.durationMs, 203_400)
  assert.equal(experiment?.baselinePath.costs[0]?.amount.units, "448958")
  assert.equal(experiment?.baselinePath.costs[0]?.amount.symbol, "ns")
})

test("the published files bind the exact signed task, manifest, payment, and replay scope", async () => {
  const inputBytes = await readFile(resolve(evidenceRoot, "input.json"))
  const task = JSON.parse(await readFile(resolve(evidenceRoot, "task.json"), "utf8")) as {
    inputHash: Hex
    constraints: { token0BudgetUnits: string; token1BudgetUnits: string; minimumRangeWidthTicks: number; targetRangeWidthTicks: number; maximumRangeWidthTicks: number }
  }
  assert.equal(inputBytes.byteLength, 3552)
  assert.equal(createHash("sha256").update(inputBytes).digest("hex"), "5cab77af274b22378e608ca3c17e902ae7f504b058c242fb99b62185037c0f1d")
  assert.equal(keccak256(toHex(inputBytes)), task.inputHash)
  assert.deepEqual(task.constraints, {
    token0BudgetUnits: "100000000000000000000000000000000000000000000000000000000000",
    token1BudgetUnits: "100000000000000000000000000000000000000000000000000000000000",
    minimumRangeWidthTicks: 100,
    targetRangeWidthTicks: 1200,
    maximumRangeWidthTicks: 5000,
    maximumSlippageBps: 50,
    gasBudgetWei: "100000000000000000",
    cooldownSeconds: 300,
    executionMode: "analysis",
  })

  const manifestBytes = await readFile(resolve(evidenceRoot, "agent-manifest.json"))
  assert.equal(manifestBytes.byteLength, 2181)
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), "ca13ae8a177a33a5180762ceaca2faa8bf8415d14079e52980fb5bec3130432a")
  assert.equal(keccak256(toHex(manifestBytes)), "0xdc56e86a67d947da546e21c901a9e03eb9cb3889bbe2bb3b480e1257b28bb20d")
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { response: { content: string } }
  const agentArtifactBytes = await readFile(resolve(evidenceRoot, "agent-artifact.json"))
  assert.equal(agentArtifactBytes.byteLength, 1633)
  assert.equal(createHash("sha256").update(agentArtifactBytes).digest("hex"), "17d9a7793864e110c175719fe72ebb8a247a3dfe4e22ccfe6c14f957b09e0298")
  assert.equal(agentArtifactBytes.toString("utf8"), manifest.response.content)
  const agentArtifact = JSON.parse(agentArtifactBytes.toString("utf8")) as unknown
  assert.deepEqual(JSON.parse(manifest.response.content) as unknown, agentArtifact)

  const signing = JSON.parse(await readFile(resolve(evidenceRoot, "signed-negotiation.json"), "utf8")) as {
    identity: { seller: string }
    request: { signedJobDescriptionFile: string; signedJobDescriptionByteLength: number; signedJobDescriptionSha256: string; decodedSha256: string; decodedKeccak256: string }
    response: { negotiationHash: Hex; providerSignature: Hex }
    verification: { recoveredSigner: string; signatureValid: boolean; decodedRequestMatchesInputFile: boolean; onChainDescriptionMatches: boolean; jobDescriptionParsesWithPinnedSdk: boolean }
  }
  const signedJobDescriptionBytes = await readFile(resolve(evidenceRoot, signing.request.signedJobDescriptionFile))
  assert.equal(signedJobDescriptionBytes.byteLength, signing.request.signedJobDescriptionByteLength)
  assert.equal(createHash("sha256").update(signedJobDescriptionBytes).digest("hex"), signing.request.signedJobDescriptionSha256)
  const description = JobDescription.fromStr(signedJobDescriptionBytes.toString("utf8"))
  assert.ok(description)
  const transportPrefix = "knot-json-deflate-base64url/1:"
  assert.ok(description.task.startsWith(transportPrefix))
  const decodedRequest = inflateRawSync(Buffer.from(description.task.slice(transportPrefix.length), "base64url"))
  assert.deepEqual(decodedRequest, inputBytes)
  const recovered = await recoverMessageAddress({ message: signing.response.negotiationHash, signature: signing.response.providerSignature })
  assert.equal(recovered.toLowerCase(), signing.identity.seller.toLowerCase())
  assert.equal(signing.request.decodedSha256, createHash("sha256").update(inputBytes).digest("hex"))
  assert.equal(signing.request.decodedKeccak256, keccak256(toHex(inputBytes)))
  assert.deepEqual(signing.verification, {
    recoveredSigner: "0xE4feD886b4b9062486d4663c6962E14473Bd7320",
    signatureValid: true,
    decodedRequestMatchesInputFile: true,
    onChainDescriptionMatches: true,
    jobDescriptionParsesWithPinnedSdk: true,
  })

  const jobSource = await readFile(resolve(evidenceRoot, "job-1189.json"), "utf8")
  const job = JSON.parse(jobSource) as {
    network: { identityChainId: number; paymentChainId: number; dataChainId: number; executionChainId: null; mainnetWrites: boolean; realFunds: boolean }
    payment: { exactPriceBaseUnits: string }
    job: { terminalStatus: string; deliverable: string }
    transactions: { settle: { receiptStatus: string; paymentTransfer: { amountBaseUnits: string } } }
    paymentBalances: unknown
    deliverable: { rawSha256: string; manifestKeccak256: string }
    agentLifecycle: { durationMs: number }
    limitations: string[]
  }
  assert.deepEqual(job.network, { identityChainId: 97, paymentChainId: 97, dataChainId: 56, executionChainId: null, mode: "analysis", mainnetWrites: false, realFunds: false })
  assert.equal(job.payment.exactPriceBaseUnits, "100000000000000000")
  assert.equal(job.job.terminalStatus, "COMPLETED")
  assert.equal(job.transactions.settle.receiptStatus, "success")
  assert.equal(job.transactions.settle.paymentTransfer.amountBaseUnits, "100000000000000000")
  assert.equal(job.agentLifecycle.durationMs, 203_400)
  assert.ok(job.limitations.some((value) => value.includes("historical replay")))
  assert.doesNotMatch(jobSource, /client_secret|access_token|password|private.?key|sk-proj/i)

  const aggregate = JSON.parse(await readFile(resolve("evidence/testnet/analysis-paid-jobs-1187-1189.json"), "utf8")) as {
    jobs: Array<{ jobId: string; terminalStatus: string; transactions: unknown; balances: unknown; deliverable: { rawSha256: string; manifestKeccak256: string } }>
  }
  const sourceJob = aggregate.jobs.find((value) => value.jobId === "1189")
  assert.ok(sourceJob)
  assert.equal(job.job.terminalStatus, sourceJob.terminalStatus)
  assert.deepEqual(job.transactions, sourceJob.transactions)
  assert.deepEqual(job.paymentBalances, sourceJob.balances)
  assert.equal(job.deliverable.rawSha256, sourceJob.deliverable.rawSha256)
  assert.equal(job.deliverable.manifestKeccak256, sourceJob.deliverable.manifestKeccak256)
})

test("RangePilot 1189 evidence fails closed after task or artifact tampering", async () => {
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as ExperimentDataset
  const alteredTask = structuredClone(dataset)
  const task = alteredTask.experiments[0]?.task.spec
  assert.ok(task)
  assert.equal(task.category, "rebalancing")
  if (task.category !== "rebalancing") throw new Error("unexpected task category")
  task.constraints.targetRangeWidthTicks = 1201
  await assert.rejects(
    validateExperimentDataset(alteredTask, resolveEvidence, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVALUATION_MISMATCH",
  )

  await assert.rejects(
    validateExperimentDataset(dataset, async (reference) => {
      const bytes = await resolveEvidence(reference)
      return reference.uri === "agent-manifest.json" ? new Uint8Array([...bytes, 0x20]) : bytes
    }, [evaluator]),
    (error) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )
})

async function verifiedDataset(): Promise<ExperimentDataset> {
  const source = await readFile(datasetPath, "utf8")
  return validateExperimentDataset(JSON.parse(source) as unknown, resolveEvidence, [evaluator])
}

async function resolveEvidence(reference: { uri: string }): Promise<Uint8Array> {
  return readFile(resolve(evidenceRoot, reference.uri))
}
