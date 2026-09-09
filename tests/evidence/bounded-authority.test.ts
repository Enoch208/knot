import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JsonObject = Record<string, unknown>;

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

const firstObjectAt = (parent: JsonObject, key: string): JsonObject => {
  const value = arrayAt(parent, key);
  assert.equal(value.length, 1);
  const first = value[0];
  assertObject(first);
  return first;
};

const evidencePath = "evidence/testnet/bounded-authority-grant-revoke.json";
const claimsPath = "evidence/claims.json";

test("bounded authority is testnet-only and grants one exact read", () => {
  const evidence = readObject(evidencePath);
  const network = objectAt(evidence, "network");
  const scope = objectAt(evidence, "scope");
  const authority = objectAt(evidence, "requestedAuthority");
  const allowed = firstObjectAt(authority, "allowedCalls");
  const nativeSpend = firstObjectAt(authority, "nativeSpendLimits");

  assert.equal(network.chainId, 97);
  assert.equal(network.name, "BSC testnet");
  assert.equal(scope.executionMode, "direct ERC-7821 account execution");
  assert.equal(scope.helperGrantUsed, false);
  assert.equal(scope.mainnetWrites, false);
  assert.equal(scope.realFunds, false);
  assert.equal(scope.tokenTransfers, false);
  assert.equal(scope.tokenApprovals, false);
  assert.equal(allowed.target, "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565");
  assert.equal(allowed.functionSignature, "balanceOf(address)");
  assert.equal(allowed.selector, "0x70a08231");
  assert.equal(allowed.valueWei, "0");
  assert.equal(nativeSpend.asset, "native tBNB");
  assert.equal(nativeSpend.period, "hour");
  assert.equal(nativeSpend.periodCode, 1);
  assert.equal(nativeSpend.limitWei, "5000000000000000");
  assert.deepEqual(arrayAt(authority, "tokenSpendPermissions"), []);
  assert.equal(authority.expirySeconds, 3600);
  assert.equal(authority.expiryUtc, "2026-09-09T11:32:18.000Z");
});

test("preflight and readback reject wildcard and expanded authority", () => {
  const evidence = readObject(evidencePath);
  const preflight = objectAt(evidence, "grantPreflight");
  const accountCalls = arrayAt(preflight, "accountCalls").map((value) => {
    assertObject(value);
    return value.selector;
  });
  const readback = objectAt(evidence, "authorityReadback");
  const nativeSpend = firstObjectAt(readback, "nativeSpendPermissions");

  assert.deepEqual(accountCalls, ["0xcebfe336", "0x136a12f7", "0x598daac4"]);
  assert.equal(preflight.decodedTargetMatches, true);
  assert.equal(preflight.decodedSelectorMatches, true);
  assert.equal(preflight.decodedCapMatches, true);
  assert.equal(preflight.decodedExpiryMatches, true);
  assert.equal(preflight.wildcardSentinelPresent, false);
  assert.equal(readback.accountIsSuperAdmin, false);
  assert.equal(readback.canExecuteAllowedSelector, true);
  assert.equal(readback.canExecuteWrongSelector, false);
  assert.equal(readback.canExecuteOrchestratorWildcard, false);
  assert.deepEqual(arrayAt(readback, "packedCallPermissions"), [
    "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565000000000000000070a08231",
  ]);
  assert.equal(nativeSpend.asset, "0x0000000000000000000000000000000000000000");
  assert.equal(nativeSpend.periodCode, 1);
  assert.equal(nativeSpend.limitWei, "5000000000000000");
  assert.equal(readback.tokenSpendPermissionCount, 0);
  assert.deepEqual(arrayAt(readback, "callCheckers"), []);
  assert.deepEqual(arrayAt(readback, "globalPackedCallPermissions"), []);
  assert.deepEqual(arrayAt(readback, "globalCallCheckers"), []);
});

test("allowed read, denial, revoke, and balance reconciliation are internally consistent", () => {
  const evidence = readObject(evidencePath);
  const grant = objectAt(evidence, "grant");
  const allowed = objectAt(evidence, "allowedCall");
  const denied = objectAt(evidence, "activeWrongSelectorCheck");
  const revoke = objectAt(evidence, "revoke");
  const revoked = objectAt(evidence, "postRevokeCheck");
  const balances = objectAt(evidence, "balanceReconciliation");
  const verification = objectAt(evidence, "verification");
  const transactions = [grant, allowed, revoke];
  const transactionPattern = /^0x[0-9a-f]{64}$/;

  for (const transaction of transactions) {
    assert.match(String(transaction.transactionHash), transactionPattern);
    assert.equal(transaction.receiptStatus, "success");
    assert.match(String(transaction.url), /^https:\/\/testnet\.bscscan\.com\/tx\/0x[0-9a-f]{64}$/);
  }

  assert.ok(BigInt(String(grant.blockNumber)) < BigInt(String(allowed.blockNumber)));
  assert.ok(BigInt(String(allowed.blockNumber)) < BigInt(String(revoke.blockNumber)));
  assert.equal(allowed.selector, "0x70a08231");
  assert.equal(allowed.valueWei, "0");
  assert.equal(denied.selector, "0x18160ddd");
  assert.equal(denied.rejected, true);
  assert.equal(denied.revertReason, "UnauthorizedCall");
  assert.equal(denied.broadcast, false);
  assert.equal(denied.transactionHash, null);
  assert.equal(revoked.formerAllowedSelector, "0x70a08231");
  assert.equal(revoked.rejected, true);
  assert.equal(revoked.revertReason, "KeyDoesNotExist");
  assert.equal(revoked.broadcast, false);
  assert.equal(revoked.transactionHash, null);
  assert.equal(revoked.keyStoreValid, false);
  assert.equal(revoked.keyStoreKeyPresent, false);
  assert.equal(revoked.accountKeyPresent, false);
  assert.equal(revoked.onlyAdminKeyRemained, true);
  assert.equal(balances.tokenBalanceRawBefore, balances.tokenBalanceRawAfter);
  assert.equal(balances.tokenBalanceUnchanged, true);
  assert.equal(balances.commerceAllowanceRawBefore, "0");
  assert.equal(balances.commerceAllowanceRawAfter, "0");
  assert.equal(balances.commerceAllowanceUnchanged, true);

  const nativeDelta = BigInt(String(balances.nativeWeiAfter)) - BigInt(String(balances.nativeWeiBefore));
  const gasWei = transactions.reduce(
    (total, transaction) => total + BigInt(String(transaction.gasUsed)) * BigInt(String(transaction.effectiveGasPriceWei)),
    0n,
  );
  const totalCost = BigInt(String(balances.registrationFeeWei)) + gasWei;
  assert.equal(nativeDelta, BigInt(String(balances.nativeBalanceDeltaWei)));
  assert.equal(gasWei, BigInt(String(balances.transactionGasWei)));
  assert.equal(totalCost, -nativeDelta);
  assert.equal(verification.exactAuthorityReadbackPassed, true);
  assert.equal(verification.wrongSelectorRejected, true);
  assert.equal(verification.formerPermissionRejectedAfterRevoke, true);
  assert.equal(verification.sessionAbsentAfterRevoke, true);
});

test("claim ledger links the supported claim to the sanitized evidence", () => {
  const claims = readObject(claimsPath);
  const claim = arrayAt(claims, "claims").find((value) => {
    assertObject(value);
    return value.id === "bounded-authority-grant-revoke";
  });
  assertObject(claim);
  const scope = objectAt(claim, "scope");
  const sources = arrayAt(claim, "sources");
  const evidenceSource = sources.find((value) => {
    assertObject(value);
    return value.type === "testnet_authority_evidence";
  });
  assertObject(evidenceSource);

  assert.equal(claim.status, "SUPPORTED");
  assert.deepEqual(claim.evidenceClasses, ["testnet_observation"]);
  assert.equal(scope.chainId, 97);
  assert.equal(scope.allowedSelector, "0x70a08231");
  assert.equal(scope.nativeSpendLimitWeiPerHour, "5000000000000000");
  assert.equal(scope.tokenSpendPermissionCount, 0);
  assert.equal(scope.mainnetWrites, false);
  assert.equal(evidenceSource.path, evidencePath);
});
