import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JsonObject = Record<string, unknown>;

const evidencePath = "evidence/testnet/analysis-sellers-2297-2299.json";
const claimsPath = "evidence/claims.json";
const transactionPattern = /^0x[0-9a-f]{64}$/;

const readObject = (path: string): JsonObject => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertObject(parsed);
  return parsed;
};

function assertObject(value: unknown): asserts value is JsonObject {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

const objectAt = (parent: JsonObject, key: string): JsonObject => {
  const value = parent[key];
  assertObject(value);
  return value;
};

const arrayAt = (parent: JsonObject, key: string): unknown[] => {
  const value = parent[key];
  assert.ok(Array.isArray(value));
  return value;
};

test("analysis sellers preserve the mainnet-read and testnet-commerce boundary", () => {
  const evidence = readObject(evidencePath);
  const boundary = objectAt(evidence, "networkBoundary");
  const dataReads = objectAt(boundary, "dataReads");
  const identityAndCommerce = objectAt(boundary, "identityAndCommerce");
  const fundingSource = objectAt(evidence, "fundingSource");

  assert.equal(evidence.schemaVersion, "knot.testnet-analysis-sellers-evidence/1");
  assert.equal(dataReads.name, "BSC mainnet");
  assert.equal(dataReads.chainId, 56);
  assert.equal(identityAndCommerce.name, "BSC testnet");
  assert.equal(identityAndCommerce.chainId, 97);
  assert.equal(identityAndCommerce.registry, "0x8004A818BFB912233c491871b3d84c89A494BD9e");
  assert.equal(boundary.mainnetWrites, false);
  assert.equal(boundary.realFunds, false);
  assert.equal(boundary.tokenTransfers, false);
  assert.equal(fundingSource.asset, "tBNB");
  assert.equal(fundingSource.amountWeiPerSeller, "5000000000000000");
  assert.equal(fundingSource.uTransferred, false);
});

test("three isolated sellers have authenticated, durable, analysis-only surfaces", () => {
  const evidence = readObject(evidencePath);
  const expected = new Map([
    ["rangepilot", { category: "rebalancing", agentId: "2297", host: "knot-range.truematchx.com" }],
    ["gridquant", { category: "grid", agentId: "2298", host: "knot-grid.truematchx.com" }],
    ["yieldscout", { category: "yield", agentId: "2299", host: "knot-yield.truematchx.com" }],
  ]);
  const sellers = arrayAt(evidence, "sellers");
  const owners = new Set<string>();
  const identities = new Set<string>();

  assert.equal(sellers.length, expected.size);

  for (const value of sellers) {
    assertObject(value);
    const seller = value;
    const key = String(seller.key);
    const expectedSeller = expected.get(key);
    assert.ok(expectedSeller);
    const identity = objectAt(seller, "identity");
    const service = objectAt(identity, "service");
    const deployment = objectAt(seller, "deployment");
    const endpoint = objectAt(seller, "endpointVerification");
    const artifact = objectAt(seller, "artifactVerification");
    const owner = String(identity.owner);
    const agentId = String(identity.agentId);
    const cardUrl = new URL(String(deployment.agentCardUrl));
    const proofUrl = new URL(String(deployment.domainRegistrationUrl));
    const artifactUrl = new URL(String(artifact.url));

    assert.equal(seller.category, expectedSeller.category);
    assert.equal(seller.capability, "analysis");
    assert.match(String(seller.dataScope), /BSC mainnet/);
    assert.equal(agentId, expectedSeller.agentId);
    assert.match(owner, /^0x[0-9A-Fa-f]{40}$/);
    assert.equal(String(identity.description).includes("analysis-only"), true);
    assert.equal(String(identity.description).includes("BSC mainnet"), true);
    assert.equal(String(identity.description).includes("BSC testnet"), true);
    assert.equal(identity.registration, "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e");
    assert.equal(service.name, "A2A");
    assert.equal(service.version, "0.3.0");
    assert.equal(service.endpoint, deployment.agentCardUrl);
    assert.equal(deployment.hosting, "self-hosted VPS");
    assert.equal(deployment.containerHealth, "healthy");
    assert.equal(deployment.rootFilesystemReadOnly, true);
    assert.equal(cardUrl.hostname, expectedSeller.host);
    assert.equal(proofUrl.origin, cardUrl.origin);
    assert.equal(endpoint.agentCardHttpStatus, 200);
    assert.equal(endpoint.domainRegistrationHttpStatus, 200);
    assert.equal(endpoint.oauthTokenHttpStatus, 200);
    assert.equal(endpoint.oauthTokenTtlSeconds, 900);
    assert.equal(endpoint.unauthenticatedInvocationHttpStatus, 401);
    assert.equal(endpoint.authenticatedNegotiation, "accepted");
    assert.equal(endpoint.providerSignaturePresent, true);
    assert.equal(endpoint.quoteChainId, 97);
    assert.deepEqual(endpoint.operationIds, ["negotiate", "notify_funded"]);
    assert.equal(artifact.contentAddressed, true);
    assert.equal(artifact.httpStatus, 200);
    assert.equal(artifactUrl.pathname.includes(`/knot-deliverables/${key}/sha256/`), true);
    assert.equal(artifactUrl.pathname.endsWith(`/${artifact.sha256}.json`), true);
    owners.add(owner.toLowerCase());
    identities.add(agentId);
  }

  assert.equal(owners.size, expected.size);
  assert.equal(identities.size, expected.size);
});

test("funding, registration, index, and balances reconcile without token funds", () => {
  const evidence = readObject(evidencePath);
  const sellers = arrayAt(evidence, "sellers");

  for (const value of sellers) {
    assertObject(value);
    const funding = objectAt(value, "funding");
    const registration = objectAt(value, "registrationTransaction");
    const index = objectAt(value, "indexObservation");
    const balance = objectAt(value, "balanceObservation");

    for (const transaction of [funding, registration]) {
      assert.match(String(transaction.transactionHash), transactionPattern);
      assert.match(String(transaction.blockHash), transactionPattern);
      assert.match(String(transaction.blockNumber), /^\d+$/);
      assert.equal(transaction.receiptStatus, "success");
    }

    assert.equal(funding.asset, "tBNB");
    assert.equal(funding.amountWei, "5000000000000000");
    assert.equal(registration.effectiveGasPriceWei, "0");
    assert.equal(registration.walletPaidWei, "0");
    assert.equal(index.foundByName, true);
    assert.equal(index.foundByAgentId, true);
    assert.deepEqual(index.supportedProtocols, ["A2A"]);
    assert.equal(index.isVerified, false);
    assert.equal(balance.nativeWei, "5000000000000000");
    assert.equal(balance.uBaseUnits, "0");
  }

  const verification = objectAt(evidence, "verification");
  assert.equal(verification.distinctWallets, true);
  assert.equal(verification.directRegistryDecodePassed, true);
  assert.equal(verification.ownersMatchRegistrationSenders, true);
  assert.equal(verification.serviceEndpointsMatchPublicCards, true);
  assert.equal(verification.domainRegistrationProofsLive, true);
  assert.equal(verification.oauthRequired, true);
  assert.equal(verification.signedQuotesObserved, true);
  assert.equal(verification.durableArtifactsRetrieved, true);
  assert.equal(verification.allIdentitiesFoundOn8004scan, true);
  assert.equal(verification.all8004scanVerifiedFlags, false);
});

test("claim ledger links each supported public seller to the sanitized evidence", () => {
  const claims = readObject(claimsPath);
  const claimIds = ["rangepilot-public-seller", "gridquant-public-seller", "yieldscout-public-seller"];

  for (const claimId of claimIds) {
    const claim = arrayAt(claims, "claims").find((value) => {
      assertObject(value);
      return value.id === claimId;
    });
    assertObject(claim);
    const scope = objectAt(claim, "scope");
    const source = arrayAt(claim, "sources").find((value) => {
      assertObject(value);
      return value.type === "deployment_evidence";
    });
    assertObject(source);

    assert.equal(claim.status, "SUPPORTED");
    assert.deepEqual(claim.evidenceClasses, ["publisher_claim", "testnet_observation"]);
    assert.equal(scope.dataChainId, 56);
    assert.equal(scope.identityChainId, 97);
    assert.equal(scope.commerceChainId, 97);
    assert.equal(scope.executionChainId, null);
    assert.equal(scope.mainnetWrites, false);
    assert.equal(scope.realFunds, false);
    assert.equal(source.path, evidencePath);
  }
});
