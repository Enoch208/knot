import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGridQuantText, encodeSignedTaskTransport } from "../src/gridQuant.js";
import { SellerCore, type SigningApi } from "../src/sellerCore.js";
import { NOW, gridFixture } from "./gridFixture.js";

class TestSellerCore extends SellerCore {
  deliver(jobId: number): Promise<Record<string, unknown>> {
    return this.doWorkAndSubmit(jobId);
  }
}

test("the funded delivery submits a typed artifact from the signed task", async () => {
  const task = encodeSignedTaskTransport(JSON.stringify(gridFixture()));
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
    generator: "gridquant",
    signing,
    pendingJobs: async () => ({ jobs: [] }),
    runWork: async (input) => analyzeGridQuantText(input, NOW),
  });
  const result = await core.deliver(8);
  const artifact = JSON.parse(submitted) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(artifact.schemaVersion, "knot.gridquant.artifact/1");
  assert.equal(artifact.status, "ANALYZED");
});
