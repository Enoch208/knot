import assert from "node:assert/strict"
import test from "node:test"
import { buildGuidedLifecycle, guidedJobIds } from "../../apps/web/src/guided-lifecycle.ts"
import snapshot from "../../apps/web/src/job-records.snapshot.json" with { type: "json" }
import type { JobRecord } from "../../apps/web/src/job-records.ts"

const requireJob = (jobId: string) => {
  const job = (snapshot.jobs as readonly JobRecord[]).find((entry) => entry.jobId === jobId)
  assert.ok(job, `retained job ${jobId} must exist`)
  return job
}

test("guided demo has retained receipts for all four KNOT agents", () => {
  for (const jobId of [guidedJobIds.healthguard, guidedJobIds.rangepilot, guidedJobIds.gridquant, guidedJobIds.yieldscout]) {
    const lifecycle = buildGuidedLifecycle(requireJob(jobId))
    assert.equal(lifecycle.terminalTone, "settled")
    assert.deepEqual(lifecycle.stages.map((stage) => stage.state), ["recorded", "recorded", "recorded", "recorded"])
    assert.equal(lifecycle.stages[0]!.label, "FUNDED")
    assert.equal(lifecycle.stages[1]!.label, "SUBMITTED")
    assert.equal(lifecycle.stages[2]!.label, "VERIFIED ARTIFACT")
    assert.equal(lifecycle.stages[3]!.label, "COMPLETED")
    assert.match(lifecycle.stages[2]!.detail, /^Retained bytes use SHA-256 /)
  }
})

test("guided refund path never invents seller work or an artifact", () => {
  const lifecycle = buildGuidedLifecycle(requireJob(guidedJobIds.refund))
  assert.equal(lifecycle.terminalTone, "failed")
  assert.equal(lifecycle.stages[0]!.state, "recorded")
  assert.equal(lifecycle.stages[1]!.summary, "No delivery submitted")
  assert.equal(lifecycle.stages[1]!.transactionUrl, null)
  assert.equal(lifecycle.stages[2]!.summary, "No artifact available")
  assert.equal(lifecycle.stages[2]!.label, "ARTIFACT UNAVAILABLE")
  assert.equal(lifecycle.stages[2]!.transactionUrl, null)
  assert.equal(lifecycle.stages[3]!.state, "refunded")
  assert.equal(lifecycle.stages[3]!.label, "REFUNDED")
  assert.match(lifecycle.stages[3]!.detail, /returned in full/)
})
