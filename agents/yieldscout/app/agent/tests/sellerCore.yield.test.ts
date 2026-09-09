import assert from "node:assert/strict";
import test from "node:test";
import { analyzeYieldScoutText, encodeSignedTaskTransport } from "../src/yieldScout.js";
import { SellerCore, type SigningApi } from "../src/sellerCore.js";
import { NOW, yieldFixture } from "./yieldFixture.js";

class TestSellerCore extends SellerCore {
  deliver(jobId: number): Promise<Record<string, unknown>> {
    return this.doWorkAndSubmit(jobId);
  }
}

test("the funded delivery submits a typed artifact from the signed task", async () => {
  const task = encodeSignedTaskTransport(JSON.stringify(yieldFixture()));
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
    generator: "yieldscout",
    signing,
    pendingJobs: async () => ({ jobs: [] }),
    runWork: async (input) => analyzeYieldScoutText(input, NOW),
  });
  const result = await core.deliver(9);
  const artifact = JSON.parse(submitted) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(artifact.schemaVersion, "knot.yield.artifact/1");
  assert.equal(artifact.status, "ASSESSED");
});
