import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRangePilotText, encodeSignedTaskTransport } from "../src/rangePilot.js";
import { SellerCore, type SigningApi } from "../src/sellerCore.js";
import { NOW, rangeFixture } from "./rangeFixture.js";

class TestSellerCore extends SellerCore {
  deliver(jobId: number): Promise<Record<string, unknown>> {
    return this.doWorkAndSubmit(jobId);
  }
}

test("the funded delivery submits a typed artifact from the signed task", async () => {
  const task = encodeSignedTaskTransport(JSON.stringify(rangeFixture()));
  let submitted = "";
  const signing: SigningApi = {
    listPrice: () => 1n,
    clampPrice: (price) => price,
    signQuote: async () => ({}),
    verifySignedJob: async () => ({ ok: true, reason: "", permanent: false }),
    jobSpec: async () => ({ task, terms: {} }),
    submitResult: async (_jobId, responseContent) => {
      submitted = responseContent;
      return { submitTx: "0xsubmit", deliverableUrl: "ipfs://artifact" };
    },
  };
  const core = new TestSellerCore({
    generator: "rangepilot",
    signing,
    pendingJobs: async () => ({ jobs: [] }),
    runWork: async (input) => analyzeRangePilotText(input, NOW),
  });
  const result = await core.deliver(7);
  const artifact = JSON.parse(submitted) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(artifact.schemaVersion, "knot.rangepilot.artifact/1");
  assert.equal(artifact.status, "ANALYZED");
});
