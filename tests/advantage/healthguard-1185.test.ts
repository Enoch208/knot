import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { HealthGuardIndependentEvaluator } from "../../packages/advantage/src/healthguard.ts"
import { validateExperimentDataset } from "../../packages/advantage/src/runner.ts"

const datasetPath = resolve("evidence/advantage/healthguard-1185/dataset.json")
const evidenceRoot = dirname(datasetPath)

test("the paid HealthGuard experiment is independently reproducible from raw evidence", async () => {
  const datasetSource = await readFile(datasetPath, "utf8")
  const dataset = await validateExperimentDataset(
    JSON.parse(datasetSource) as unknown,
    async (reference) => readFile(resolve(evidenceRoot, reference.uri)),
    [new HealthGuardIndependentEvaluator()],
  )
  const experiment = dataset.experiments[0]
  assert.equal(dataset.experiments.length, 1)
  assert.equal(experiment?.experimentId, "healthguard-1185")
  assert.deepEqual(experiment?.comparison, {
    winner: "tie",
    agentWins: 0,
    baselineWins: 0,
    ties: 4,
    decisiveDimensionId: null,
  })
  assert.ok(experiment?.evaluation.dimensions.every((dimension) => dimension.agent.scoreBps === 10_000 && dimension.baseline.scoreBps === 10_000))
})

test("job 1185 evidence proves terminal testnet payment without a mainnet write", async () => {
  const source = await readFile(resolve(evidenceRoot, "job-1185.json"), "utf8")
  const evidence = JSON.parse(source) as {
    dataInput: { chainId: number }
    payment: { exactPriceBaseUnits: string; mainnetFundsUsed: boolean }
    job: { status: number }
    transactions: { settle: { receiptStatus: string; paymentTransfer: { amountBaseUnits: string } } }
    verification: { terminalState: string }
  }
  assert.equal(evidence.dataInput.chainId, 56)
  assert.equal(evidence.payment.exactPriceBaseUnits, "100000000000000000")
  assert.equal(evidence.payment.mainnetFundsUsed, false)
  assert.equal(evidence.job.status, 3)
  assert.equal(evidence.transactions.settle.receiptStatus, "success")
  assert.equal(evidence.transactions.settle.paymentTransfer.amountBaseUnits, "100000000000000000")
  assert.equal(evidence.verification.terminalState, "COMPLETED")
  assert.doesNotMatch(source, /client_secret|access_token|password|private.?key|sk-proj/i)
})
