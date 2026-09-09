import assert from "node:assert/strict"
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
    assert.doesNotThrow(() => assertChainActionTransition("SUBMITTED", "UNKNOWN"))
    assert.doesNotThrow(() => assertChainActionTransition("UNKNOWN", "CONFIRMED"))
    assert.throws(() => assertChainActionTransition("UNKNOWN", "SUBMITTED"), InvalidStateTransitionError)
    assert.throws(() => assertChainActionTransition("CONFIRMED", "CONFIRMED"), InvalidStateTransitionError)
  })
})
