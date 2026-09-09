import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { AdvantageValidationError, validateExperimentDataset } from "../../packages/advantage/src/runner.ts"
import { YieldScoutIndependentEvaluator } from "../../packages/advantage/src/yieldscout.ts"

const datasetPath = resolve("evidence/advantage/yieldscout-1188/dataset.json")
const evidenceRoot = dirname(datasetPath)
const evaluator = new YieldScoutIndependentEvaluator()

test("the paid YieldScout experiment is independently reproducible from raw evidence", async () => {
  const dataset = await loadDataset()
  const validated = await validateExperimentDataset(dataset, localResolver, [evaluator])
  const experiment = validated.experiments[0]
  assert.equal(validated.experiments.length, 1)
  assert.equal(experiment?.experimentId, "yieldscout-1188")
  assert.deepEqual(experiment?.comparison, {
    winner: "tie",
    agentWins: 0,
    baselineWins: 0,
    ties: 5,
    decisiveDimensionId: null,
  })
  assert.ok(experiment?.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000))
})

test("job 1188, frozen input, task, snapshot, manifest, and artifact remain byte-bound", async () => {
  const [paidSource, taskBytes, inputBytes, manifestBytes, artifactBytes, snapshotBytes] = await Promise.all([
    readFile(resolve(evidenceRoot, "paid-jobs-source.json")),
    readFile(resolve(evidenceRoot, "task.json")),
    readFile(resolve(evidenceRoot, "input.json")),
    readFile(resolve(evidenceRoot, "agent-manifest.json")),
    readFile(resolve(evidenceRoot, "agent-artifact.json")),
    readFile(resolve(evidenceRoot, "source-market-snapshot.json")),
  ])
  assert.equal(sha256(paidSource), "902c43995c0b05425c4aa52433b7ae193d839d9f896b0568ce792cf27550c13e")
  assert.equal(sha256(taskBytes), "b8e706e5bfd5073bc2faa4b5e3476657d24b35925e6055fdee2b0182e126df60")
  assert.equal(sha256(inputBytes), "8893fdb8507e7dfb580f9d5b5406bb7530ab731d0bc0b866fc2338a91651b33b")
  assert.equal(sha256(manifestBytes), "c3fbb46a4df2110bf3d3f9dfa5c101d5488c0b0c6cd0c4afbc62103cc550edd9")
  assert.equal(sha256(artifactBytes), "615a5208021eee8ae6ac14a8da32b0ba38ce48f07f2486c87220734609fab7b6")

  const paidEvidence = JSON.parse(paidSource.toString("utf8")) as {
    networkBoundary: { dataReads: { chainId: number }; identityAndCommerce: { chainId: number }; mainnetWrites: boolean; realFunds: boolean; mode: string }
    jobs: Array<{
      category: string
      jobId: string
      terminalStatus: string
      priceBaseUnits: string
      taskBinding: { inputHash: string; snapshotId: string }
      deliverable: { rawSha256: string; manifestKeccak256: string }
      transactions: { settle: { hash: string; receiptStatus: string; paymentTransfer: { amountBaseUnits: string } } }
    }>
  }
  const job = paidEvidence.jobs.find((item) => item.jobId === "1188")
  assert.equal(job?.category, "yieldscout")
  assert.equal(job?.terminalStatus, "COMPLETED")
  assert.equal(job?.priceBaseUnits, "100000000000000000")
  assert.equal(job?.transactions.settle.receiptStatus, "success")
  assert.equal(job?.transactions.settle.hash, "0x388afeef6359d213c0259f38601915e1e2678d304ff733281a5d3aae052861af")
  assert.equal(job?.transactions.settle.paymentTransfer.amountBaseUnits, "100000000000000000")
  assert.equal(job?.deliverable.rawSha256, sha256(manifestBytes))
  assert.equal(job?.deliverable.manifestKeccak256, "0x461090a6c99dc7634567657a948d7c23f23299a5bffc8615f7839c5492ee92a8")
  assert.deepEqual(paidEvidence.networkBoundary, {
    dataReads: { name: "BSC mainnet", chainId: 56 },
    identityAndCommerce: { name: "BSC testnet", chainId: 97 },
    executionChainId: null,
    mode: "analysis",
    mainnetWrites: false,
    realFunds: false,
  })

  const task = JSON.parse(taskBytes.toString("utf8")) as { inputHash: string; snapshotId: string }
  const input = JSON.parse(inputBytes.toString("utf8")) as { taskId: string; snapshot: unknown }
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as { extractedWithoutMutationFrom: string; snapshot: unknown }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { job_id: number; response: { content: string } }
  assert.equal(task.inputHash, job?.taskBinding.inputHash)
  assert.equal(task.snapshotId, job?.taskBinding.snapshotId)
  assert.equal(manifest.job_id, 1188)
  assert.deepEqual(JSON.parse(manifest.response.content), JSON.parse(artifactBytes.toString("utf8")))
  assert.equal(snapshot.extractedWithoutMutationFrom, "input.json")
  assert.deepEqual(snapshot.snapshot, input.snapshot)
})

test("the historical replay records its later measured runtime without posing as a contemporaneous service", async () => {
  const [dataset, observationSource, methodSource, costSource, baselineArtifactSource, agentArtifactSource] = await Promise.all([
    loadDataset(),
    readFile(resolve(evidenceRoot, "baseline-observation.json"), "utf8"),
    readFile(resolve(evidenceRoot, "baseline-method.json"), "utf8"),
    readFile(resolve(evidenceRoot, "baseline-compute-cost.json"), "utf8"),
    readFile(resolve(evidenceRoot, "baseline-artifact.json"), "utf8"),
    readFile(resolve(evidenceRoot, "agent-artifact.json"), "utf8"),
  ])
  const observation = JSON.parse(observationSource) as {
    evidenceClass: string
    evaluationAsOfUtc: string
    producedAtUtc: string
    actualMeasurement: { startedAtUtc: string; endedAtUtc: string; durationNanoseconds: string; clock: string }
    scopeMismatch: string
  }
  const method = JSON.parse(methodSource) as { usesAgentOutput: boolean; evaluationAsOfUtc: string; producedAtUtc: string; evidenceBoundary: { classification: string; scopeMismatch: string } }
  const computeCost = JSON.parse(costSource) as { units: string; symbol: string; method: string; observedAtUtc: string }
  const baselineArtifact = JSON.parse(baselineArtifactSource) as { assessedAtUtc: string; status: string; recommendation: string; selectedMarketId: string | null }
  const agentArtifact = JSON.parse(agentArtifactSource) as { assessedAtUtc: string; status: string; recommendation: string; selectedMarketId: string | null }
  const experiment = dataset.experiments[0]

  assert.equal(observation.evidenceClass, "historical_replay")
  assert.equal(method.evidenceBoundary.classification, "historical_replay")
  assert.equal(method.usesAgentOutput, false)
  assert.equal(observation.evaluationAsOfUtc, agentArtifact.assessedAtUtc)
  assert.equal(method.evaluationAsOfUtc, agentArtifact.assessedAtUtc)
  assert.equal(baselineArtifact.assessedAtUtc, agentArtifact.assessedAtUtc)
  assert.ok(Date.parse(observation.producedAtUtc) > Date.parse(experiment.agentPath.observation.endedAtUtc))
  assert.equal(observation.producedAtUtc, method.producedAtUtc)
  assert.equal(observation.actualMeasurement.endedAtUtc, observation.producedAtUtc)
  assert.equal(computeCost.units, observation.actualMeasurement.durationNanoseconds)
  assert.equal(computeCost.symbol, "ns")
  assert.equal(computeCost.method, "measured_wall_clock")
  assert.equal(computeCost.observedAtUtc, observation.producedAtUtc)
  assert.equal(observation.actualMeasurement.clock, "process.hrtime.bigint")
  assert.match(observation.scopeMismatch, /later|not a same-time/i)
  assert.match(method.evidenceBoundary.scopeMismatch, /computed later|not a contemporaneous/i)
  assert.deepEqual(
    { status: baselineArtifact.status, recommendation: baselineArtifact.recommendation, selectedMarketId: baselineArtifact.selectedMarketId },
    { status: agentArtifact.status, recommendation: agentArtifact.recommendation, selectedMarketId: agentArtifact.selectedMarketId },
  )
  assert.equal(experiment.baselinePath.rawOutput.evidenceClass, "historical_replay")
  assert.equal(experiment.baselinePath.artifact.evidenceClass, "historical_replay")
  assert.equal(experiment.agentPath.rawOutput.evidenceClass, "testnet_observation")
  assert.equal(experiment.agentPath.artifact.evidenceClass, "testnet_observation")
})

test("tampered evidence bytes and recomputed-hash semantic tampering both fail closed", async () => {
  const dataset = await loadDataset()
  await assert.rejects(
    validateExperimentDataset(
      dataset,
      async (reference) => {
        const bytes = await localResolver(reference)
        if (reference.uri !== "agent-artifact.json") return bytes
        const tampered = Uint8Array.from(bytes)
        tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b
        return tampered
      },
      [evaluator],
    ),
    (error: unknown) => error instanceof AdvantageValidationError && error.code === "EVIDENCE_MISMATCH",
  )

  const semanticTamper = structuredClone(dataset)
  const original = JSON.parse(await readFile(resolve(evidenceRoot, "baseline-artifact.json"), "utf8")) as {
    eligibleMarkets: Array<{ horizonBaseBenefitUnits: string }>
  }
  original.eligibleMarkets[0]!.horizonBaseBenefitUnits = (BigInt(original.eligibleMarkets[0]!.horizonBaseBenefitUnits) + 1n).toString()
  const tamperedBytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`)
  const reference = semanticTamper.experiments[0]!.baselinePath.artifact
  reference.sha256 = sha256(tamperedBytes)
  reference.byteLength = tamperedBytes.byteLength
  await assert.rejects(
    validateExperimentDataset(
      semanticTamper,
      async (item) => item.uri === "baseline-artifact.json" ? tamperedBytes : localResolver(item),
      [evaluator],
    ),
    (error: unknown) => error instanceof AdvantageValidationError && error.code === "EVALUATION_MISMATCH",
  )
})

test("the committed YieldScout corpus contains no credential material", async () => {
  for (const name of await readdir(evidenceRoot)) {
    const source = await readFile(resolve(evidenceRoot, name), "utf8")
    assert.doesNotMatch(source, /sk-proj-|client_secret|access_token|password|private.?key|mnemonic|keystore/i, name)
  }
})

async function loadDataset(): Promise<any> {
  return JSON.parse(await readFile(datasetPath, "utf8")) as unknown
}

async function localResolver(reference: { uri: string }): Promise<Uint8Array> {
  return readFile(resolve(evidenceRoot, reference.uri))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
