import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JsonObject = Record<string, unknown>;

const evidencePath = "evidence/testnet/analysis-paid-jobs-1187-1189.json";
const transactionPattern = /^0x[0-9a-f]{64}$/;

function object(value: unknown): JsonObject {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonObject;
}

function field(parent: JsonObject, key: string): JsonObject {
  return object(parent[key]);
}

function jobs(): JsonObject[] {
  const evidence = object(JSON.parse(readFileSync(evidencePath, "utf8")));
  assert.ok(Array.isArray(evidence.jobs));
  return evidence.jobs.map(object);
}

test("paid analysis jobs preserve mainnet-read and testnet-commerce boundaries", () => {
  const evidence = object(JSON.parse(readFileSync(evidencePath, "utf8")));
  const boundary = field(evidence, "networkBoundary");
  const data = field(boundary, "dataReads");
  const commerceBoundary = field(boundary, "identityAndCommerce");
  const commerce = field(evidence, "commerce");
  const balances = field(evidence, "aggregateBalances");

  assert.equal(evidence.schemaVersion, "knot.analysis-paid-jobs-evidence/1");
  assert.deepEqual(data, { name: "BSC mainnet", chainId: 56 });
  assert.deepEqual(commerceBoundary, { name: "BSC testnet", chainId: 97 });
  assert.equal(boundary.executionChainId, null);
  assert.equal(boundary.mode, "analysis");
  assert.equal(boundary.mainnetWrites, false);
  assert.equal(boundary.realFunds, false);
  assert.equal(commerce.jobCount, 3);
  assert.equal(commerce.priceBaseUnitsPerJob, "100000000000000000");
  assert.equal(commerce.totalPaidBaseUnits, "300000000000000000");
  assert.equal(balances.buyerDecreaseBaseUnits, commerce.totalPaidBaseUnits);
});

test("three distinct sellers completed signed 0.1 U jobs from one separate buyer", () => {
  const expected = new Map([
    ["1187", { category: "gridquant", agentId: "2298", seller: "0x3D5355A97352f4D078016342AD117a5E88D5C74f" }],
    ["1188", { category: "yieldscout", agentId: "2299", seller: "0x6fD04720c7FcCB6dCEBf6cF08dD6f5C764c7D8E3" }],
    ["1189", { category: "rangepilot", agentId: "2297", seller: "0xE4feD886b4b9062486d4663c6962E14473Bd7320" }],
  ]);
  const rows = jobs();
  const buyers = new Set<string>();
  const sellers = new Set<string>();

  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    const wanted = expected.get(String(row.jobId));
    assert.ok(wanted);
    assert.equal(row.category, wanted.category);
    assert.equal(row.agentId, wanted.agentId);
    assert.equal(String(row.seller).toLowerCase(), wanted.seller.toLowerCase());
    assert.notEqual(String(row.buyer).toLowerCase(), wanted.seller.toLowerCase());
    assert.equal(row.priceBaseUnits, "100000000000000000");
    assert.equal(row.terminalStatus, "COMPLETED");
    buyers.add(String(row.buyer).toLowerCase());
    sellers.add(String(row.seller).toLowerCase());
  }
  assert.equal(buyers.size, 1);
  assert.equal(sellers.size, 3);
});

test("quotes, closed tasks, mainnet snapshots, and durable artifacts bind exactly", () => {
  for (const row of jobs()) {
    const quote = field(row, "signedQuote");
    const task = field(row, "taskBinding");
    const snapshot = field(row, "mainnetSnapshot");
    const deliverable = field(row, "deliverable");
    const checks = field(deliverable, "checks");
    const url = new URL(String(deliverable.url));

    assert.equal(quote.valid, true);
    assert.equal(String(quote.signer).toLowerCase(), String(row.seller).toLowerCase());
    assert.equal(quote.chainId, 97);
    assert.equal(quote.onChainDescriptionMatches, true);
    assert.equal(quote.transport, "deflate-base64url");
    assert.equal(quote.taskBytesMatch, true);
    assert.ok(Number(quote.decompressedByteLength) <= 65_536);
    assert.equal(task.schema, "knot.task/1");
    assert.equal(task.closedSchema, "passed");
    assert.match(String(task.inputHash), transactionPattern);
    assert.equal(task.snapshotId, snapshot.snapshotId);
    assert.match(String(snapshot.blockHash), transactionPattern);
    assert.equal(snapshot.canonicalAtVerification, true);
    assert.equal(url.pathname.endsWith(`/${deliverable.rawSha256}.json`), true);
    assert.match(String(deliverable.manifestKeccak256), transactionPattern);
    assert.equal(checks.sha256MatchesUrl, true);
    assert.equal(checks.manifestHashMatchesOnChain, true);
    assert.equal(checks.manifestSchema, "passed");
    assert.equal(checks.artifactSchema, "passed");
    assert.equal(checks.taskAndSnapshotIdentity, "passed");
    assert.equal(checks.assessedWithinFundedDeliveryLifecycle, true);
  }
});

test("transaction receipts, challenge windows, payments, and balances reconcile", () => {
  for (const row of jobs()) {
    const transactions = field(row, "transactions");
    const policy = field(row, "disputePolicy");
    const balances = field(row, "balances");

    assert.equal(policy.disputeWindowSeconds, "900");
    for (const name of ["create", "register", "setBudget", "fund", "submit", "settle"]) {
      const transaction = field(transactions, name);
      assert.match(String(transaction.hash), transactionPattern);
      assert.match(String(transaction.blockHash), transactionPattern);
      assert.match(String(transaction.blockNumber), /^\d+$/);
      assert.equal(transaction.receiptStatus, "success");
    }
    const submit = field(transactions, "submit");
    const settle = field(transactions, "settle");
    const transfer = field(settle, "paymentTransfer");
    assert.ok(Date.parse(String(settle.timestampUtc)) >= Number(policy.settlementEligibleAt) * 1_000);
    assert.ok(BigInt(String(settle.blockNumber)) > BigInt(String(submit.blockNumber)));
    assert.equal(String(transfer.to).toLowerCase(), String(row.seller).toLowerCase());
    assert.equal(transfer.amountBaseUnits, "100000000000000000");
    assert.equal(BigInt(String(balances.sellerAfter)) - BigInt(String(balances.sellerBefore)), 100_000_000_000_000_000n);
  }
});

test("evidence limitations prohibit execution and performance inference", () => {
  const evidence = object(JSON.parse(readFileSync(evidencePath, "utf8")));
  assert.ok(Array.isArray(evidence.limitations));
  const limitations = evidence.limitations.join(" ");
  assert.match(limitations, /does not establish repeatability/);
  assert.match(limitations, /no position, order, swap, deposit, withdrawal, migration/);
  assert.match(limitations, /not performance history/);
  assert.match(limitations, /no real funds/);
});
