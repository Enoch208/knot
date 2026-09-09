import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHealthGuardText, encodeSignedTaskTransport } from "../src/healthGuard.js";
import { SellerCore, type SigningApi } from "../src/sellerCore.js";
import { healthFixture, NOW } from "./healthFixture.js";

class TestSellerCore extends SellerCore {
  deliver(jobId: number): Promise<Record<string, unknown>> {
    return this.doWorkAndSubmit(jobId);
  }
}

test("the funded delivery hook submits the typed artifact from an encoded signed task", async () => {
  const task = encodeSignedTaskTransport(JSON.stringify(healthFixture()));
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
    generator: "healthguard",
    signing,
    pendingJobs: async () => ({ jobs: [] }),
    runWork: async (input) => analyzeHealthGuardText(input, NOW),
  });
  const result = await core.deliver(7);
  const artifact = JSON.parse(submitted) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(artifact.schemaVersion, "knot.health.artifact/1");
  assert.equal(artifact.status, "ASSESSED");
});
