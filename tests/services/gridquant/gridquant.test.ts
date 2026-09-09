import assert from "node:assert/strict"
import { test } from "node:test"
import { analyzeGridQuant, GRIDQUANT_PAIR, gridQuantRequest, gridQuantResult } from "../../../packages/services/gridquant/src/index.ts"

const request = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "knot.gridquant.request/1",
  pair: {
    chainId: 56,
    baseToken: { address: GRIDQUANT_PAIR.baseToken, decimals: GRIDQUANT_PAIR.baseDecimals },
    quoteToken: { address: GRIDQUANT_PAIR.quoteToken, decimals: GRIDQUANT_PAIR.quoteDecimals },
    pool: GRIDQUANT_PAIR.pool,
  },
  lowerPriceUnits: "50000",
  upperPriceUnits: "80000",
  priceDecimals: 2,
  gridCount: 4,
  spacing: "arithmetic",
  principalQuoteUnits: "1000000000000000000000",
  orderSizeFloorQuoteUnits: "100000000000000000000",
  maxBaseInventoryUnits: "3000000000000000000",
  feeAssumptions: {
    buyFeeBps: 25,
    sellFeeBps: 25,
    estimatedNetworkFeeQuoteUnitsPerSwap: "1000000000000000",
  },
  slippageBps: 10,
  cooldownSeconds: 300,
  lastActionUtc: null,
  expiryUtc: "2026-09-10T00:00:00.000Z",
  evaluatedAtUtc: "2026-09-09T00:00:00.000Z",
  executionMode: "analysis",
  ...overrides,
})

test("closed schemas reject unknown request and result fields", () => {
  assert.equal(gridQuantRequest.safeParse(request({ unknown: true })).success, false)
  const malformed = analyzeGridQuant(request({ unknown: true }))
  assert.equal(malformed.outcome, "REJECTED")
  if (malformed.outcome === "REJECTED") assert.equal(malformed.reason, "INVALID_INPUT")
  const plan = analyzeGridQuant(request())
  assert.equal(plan.outcome, "PLAN")
  assert.equal(gridQuantResult.safeParse({ ...plan, unknown: true }).success, false)
})

test("arithmetic levels conserve quote capital and use explicit token decimal scaling", () => {
  const output = analyzeGridQuant(request())
  assert.equal(output.outcome, "PLAN")
  if (output.outcome !== "PLAN") return
  assert.deepEqual(output.levels.map((level) => level.priceUnits), ["50000", "60000", "70000", "80000"])
  assert.equal(output.capital.maximumCommittedQuoteUnits, "1000000000000000000000")
  assert.equal(output.levels[0]?.estimatedBaseUnits, "500000000000000000")
  assert.equal(output.pair.baseToken.decimals, 18)
  assert.equal(output.pair.quoteToken.decimals, 18)
  assert.equal(output.pair.poolFeeBpsPerSwap, 1)
  assert.equal(output.performance.realizedPnlQuoteUnits, null)
  assert.equal(output.performance.completedTradeCount, 0)
  assert.equal(output.fillPolicy.ambiguousFill, "NO_FILL")
})

test("geometric spacing is generated with integer roots", () => {
  const output = analyzeGridQuant(request({ lowerPriceUnits: "100", upperPriceUnits: "900", priceDecimals: 0, gridCount: 3, spacing: "geometric", maxBaseInventoryUnits: "10000000000000000000" }))
  assert.equal(output.outcome, "PLAN")
  if (output.outcome !== "PLAN") return
  assert.deepEqual(output.levels.map((level) => level.priceUnits), ["100", "300", "900"])
})

test("inverted and zero lower bounds are rejected", () => {
  for (const lowerPriceUnits of ["80000", "90000", "0"]) {
    const output = analyzeGridQuant(request({ lowerPriceUnits }))
    assert.equal(output.outcome, "REJECTED")
    if (output.outcome === "REJECTED") assert.equal(output.reason, "INVERTED_BOUNDS")
  }
})

test("grid counts outside the bounded range are rejected", () => {
  for (const gridCount of [-1, 0, 1, 101]) {
    const output = analyzeGridQuant(request({ gridCount }))
    assert.equal(output.outcome, "REJECTED")
    if (output.outcome === "REJECTED") assert.equal(output.reason, "INVALID_GRID_COUNT")
  }
  const fractional = analyzeGridQuant(request({ gridCount: 2.5 }))
  assert.equal(fractional.outcome, "REJECTED")
  if (fractional.outcome === "REJECTED") assert.equal(fractional.reason, "INVALID_INPUT")
})

test("capital below the per-level order floor is rejected", () => {
  const output = analyzeGridQuant(request({ principalQuoteUnits: "399999999999999999999" }))
  assert.equal(output.outcome, "REJECTED")
  if (output.outcome === "REJECTED") assert.equal(output.reason, "INSUFFICIENT_CAPITAL")
})

test("fees and conservative slippage cannot equal or exceed an adjacent spread", () => {
  const output = analyzeGridQuant(request({
    lowerPriceUnits: "10000",
    upperPriceUnits: "10200",
    gridCount: 3,
    feeAssumptions: { buyFeeBps: 30, sellFeeBps: 30, estimatedNetworkFeeQuoteUnitsPerSwap: "0" },
    slippageBps: 20,
    maxBaseInventoryUnits: "100000000000000000000",
  }))
  assert.equal(output.outcome, "REJECTED")
  if (output.outcome === "REJECTED") assert.equal(output.reason, "FEES_OVERWHELM_SPREAD")
})

test("fee assumptions cannot understate the configured pool fee", () => {
  const output = analyzeGridQuant(request({
    feeAssumptions: { buyFeeBps: 0, sellFeeBps: 1, estimatedNetworkFeeQuoteUnitsPerSwap: "0" },
  }))
  assert.equal(output.outcome, "REJECTED")
  if (output.outcome === "REJECTED") assert.equal(output.reason, "FEE_ASSUMPTION_UNDERSTATED")
})

test("allowlist token decimals are independently enforced", () => {
  const valid = request()
  const pair = valid.pair
  const output = analyzeGridQuant(request({ pair: { ...pair, quoteToken: { ...pair.quoteToken, decimals: 6 } } }))
  assert.equal(output.outcome, "UNSUPPORTED")
  if (output.outcome === "UNSUPPORTED") assert.equal(output.reason, "TOKEN_DECIMALS_MISMATCH")
})

test("duplicate arithmetic and geometric levels are rejected", () => {
  for (const spacing of ["arithmetic", "geometric"] as const) {
    const output = analyzeGridQuant(request({ lowerPriceUnits: "100", upperPriceUnits: "101", priceDecimals: 0, gridCount: 3, spacing }))
    assert.equal(output.outcome, "REJECTED")
    if (output.outcome === "REJECTED") assert.equal(output.reason, "DUPLICATE_LEVELS")
  }
})

test("maximum inventory exposure is enforced against a fully filled ladder", () => {
  const output = analyzeGridQuant(request({ maxBaseInventoryUnits: "1" }))
  assert.equal(output.outcome, "REJECTED")
  if (output.outcome === "REJECTED") assert.equal(output.reason, "MAX_INVENTORY_EXCEEDED")
})

test("expired and cooling-down requests return valid no-action outcomes", () => {
  const expired = analyzeGridQuant(request({ expiryUtc: "2026-09-09T00:00:00.000Z" }))
  assert.equal(expired.outcome, "NO_ACTION")
  if (expired.outcome === "NO_ACTION") assert.equal(expired.reason, "EXPIRED")
  const cooling = analyzeGridQuant(request({ lastActionUtc: "2026-09-08T23:59:00.000Z" }))
  assert.equal(cooling.outcome, "NO_ACTION")
  if (cooling.outcome === "NO_ACTION") {
    assert.equal(cooling.reason, "COOLDOWN_ACTIVE")
    assert.equal(cooling.remainingCooldownSeconds, 240)
  }
})

test("unsupported pairs and execution requests fail closed", () => {
  const base = request()
  const pair = base.pair
  const unsupportedPair = analyzeGridQuant(request({ pair: { ...pair, pool: "0x1111111111111111111111111111111111111111" } }))
  assert.equal(unsupportedPair.outcome, "UNSUPPORTED")
  const execution = analyzeGridQuant(request({ executionMode: "conditional-swaps" }))
  assert.equal(execution.outcome, "UNSUPPORTED")
  if (execution.outcome === "UNSUPPORTED") assert.equal(execution.reason, "EXECUTION_NOT_AVAILABLE")
})
