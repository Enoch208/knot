import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { prepareServiceRequest } from "../../packages/contracts/src/service-request.ts"
import { buildDemoQuoteExample, type DemoAgentSlug } from "../../apps/web/src/demo/quote-examples.ts"
import retainedExamples from "../../apps/web/src/demo/retained-examples.json" with { type: "json" }
import healthRequest from "../../evidence/advantage/healthguard-1185/input.json" with { type: "json" }
import healthTask from "../../evidence/advantage/healthguard-1185/task.json" with { type: "json" }
import gridRequest from "../../evidence/advantage/gridquant-1187/input.json" with { type: "json" }
import gridTask from "../../evidence/advantage/gridquant-1187/task.json" with { type: "json" }
import yieldRequest from "../../evidence/advantage/yieldscout-1188/input.json" with { type: "json" }
import yieldTask from "../../evidence/advantage/yieldscout-1188/task.json" with { type: "json" }

const buyer = "0x71b1373fcdffbd669b85d39b2cfb37ffb9c62930"
const slugs: DemoAgentSlug[] = ["healthguard", "rangepilot", "gridquant", "yieldscout"]

describe("four-category public quote examples", () => {
  it("keeps the deployable web copies byte-equivalent to the public evidence inputs", () => {
    assert.deepEqual(retainedExamples, {
      healthguard: { request: healthRequest, task: healthTask },
      gridquant: { request: gridRequest, task: gridTask },
      yieldscout: { request: yieldRequest, task: yieldTask },
    })
  })

  for (const agentSlug of slugs) {
    it(`keeps the ${agentSlug} seller request bound to its marketplace task`, () => {
      const example = buildDemoQuoteExample({
        agentSlug,
        targetRangeWidthTicks: 1200,
        maximumSlippageBps: 50,
      }, new Date("2026-09-13T12:01:00.000Z"))
      const prepared = prepareServiceRequest({
        schemaVersion: "knot.service-request/1",
        task: example.task,
        request: {
          mediaType: "application/json",
          schemaVersion: example.requestSchemaVersion,
          bytesBase64url: example.requestBytes.toString("base64url"),
        },
        transport: example.transport,
      }, buyer)

      assert.equal(prepared.category, example.task.category)
      assert.equal(prepared.taskId, example.taskId)
      assert.equal(prepared.snapshotId, example.task.snapshotId)
      assert.ok(example.bindings.every((binding) => binding.label && binding.value))
    })
  }
})
