import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import {
  InvalidStateTransitionError,
  assertChainActionTransition,
  assertFinancialTransition,
  assertWorkTransition,
} from "../../packages/db/src/index.ts"

describe("durable state machines", () => {
  it("keeps work completion independent from settlement", () => {
    assert.doesNotThrow(() => assertWorkTransition("OUTPUT_RECEIVED", "OUTPUT_CHECKED"))
    assert.doesNotThrow(() => assertFinancialTransition("ESCROWED", "RESOLUTION_PENDING"))
  })

  it("rejects skipped and terminal work transitions", () => {
    assert.throws(() => assertWorkTransition("DRAFT", "RUNNING"), InvalidStateTransitionError)
    assert.throws(() => assertWorkTransition("OUTPUT_CHECKED", "RUNNING"), InvalidStateTransitionError)
  })

  it("supports unknown payment reconciliation without speculative resubmission", () => {
    assert.doesNotThrow(() => assertFinancialTransition("FUNDING_PENDING", "UNKNOWN"))
    assert.doesNotThrow(() => assertFinancialTransition("UNKNOWN", "ESCROWED"))
    assert.throws(() => assertFinancialTransition("PAID", "UNKNOWN"), InvalidStateTransitionError)
  })

  it("only reconciles unknown actions to an observed terminal outcome", () => {
    assert.doesNotThrow(() => assertChainActionTransition("PREPARED", "UNKNOWN"))
    assert.doesNotThrow(() => assertChainActionTransition("SUBMITTED", "UNKNOWN"))
    assert.doesNotThrow(() => assertChainActionTransition("UNKNOWN", "CONFIRMED"))
    assert.throws(() => assertChainActionTransition("UNKNOWN", "SUBMITTED"), InvalidStateTransitionError)
    assert.throws(() => assertChainActionTransition("CONFIRMED", "CONFIRMED"), InvalidStateTransitionError)
  })

  it("keeps the forward database guard aligned with the prepared broadcast fence", async () => {
    const sql = await readFile(new URL("../../packages/db/migrations/0004_chain_action_broadcast_unknown.sql", import.meta.url), "utf8")
    assert.match(sql, /\('PREPARED', 'UNKNOWN'\)/)
    assert.doesNotMatch(sql, /\('UNKNOWN', 'SUBMITTED'\)/)
  })

  it("enforces new nonce-only records without blocking an audit of legacy rows", async () => {
    const sql = await readFile(new URL("../../packages/db/migrations/0005_chain_action_recovery.sql", import.meta.url), "utf8")
    assert.match(sql, /chain_actions_transaction_hash_required[^\n]+NOT VALID;/)
    assert.match(sql, /chain_actions_nonce_locator[^\n]+NOT VALID;/)
    assert.match(sql, /CREATE VIEW chain_action_legacy_violations/)
  })
})
