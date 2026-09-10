import assert from "node:assert/strict"
import { test } from "node:test"
import {
  SPEND_PERIOD_CODES,
  SPEND_PERIOD_LADDER,
  smallestSpendWindowContaining,
  startOfNextSpendPeriod,
  startOfSpendPeriod,
} from "../../packages/authority/src/spend-period.ts"

const OBSERVED_FROM_DEPLOYED_ACCOUNT = [
  { unix: 1_760_000_000, minute: 1_759_999_980, hour: 1_759_996_800, day: 1_759_968_000, week: 1_759_708_800, month: 1_759_276_800, year: 1_735_689_600 },
  { unix: 1_760_003_599, minute: 1_760_003_580, hour: 1_760_000_400, day: 1_759_968_000, week: 1_759_708_800, month: 1_759_276_800, year: 1_735_689_600 },
  { unix: 1_760_086_399, minute: 1_760_086_380, hour: 1_760_083_200, day: 1_760_054_400, week: 1_759_708_800, month: 1_759_276_800, year: 1_735_689_600 },
  { unix: 1_767_225_599, minute: 1_767_225_540, hour: 1_767_222_000, day: 1_767_139_200, week: 1_766_966_400, month: 1_764_547_200, year: 1_735_689_600 },
] as const

test("the period codes match the key-store serialization the account expects", () => {
  assert.deepEqual(SPEND_PERIOD_CODES, { minute: 0, hour: 1, day: 2, week: 3, month: 4, year: 5 })
  assert.deepEqual([...SPEND_PERIOD_LADDER], ["minute", "hour", "day", "week", "month", "year"])
})

test("period starts reproduce boundaries read from the deployed BSC testnet account", () => {
  for (const sample of OBSERVED_FROM_DEPLOYED_ACCOUNT) {
    for (const period of SPEND_PERIOD_LADDER) {
      assert.equal(
        startOfSpendPeriod(sample.unix, period),
        sample[period],
        `${period} boundary for ${sample.unix}`,
      )
    }
  }
})

test("each period boundary is aligned and each window strictly contains its timestamp", () => {
  for (const sample of OBSERVED_FROM_DEPLOYED_ACCOUNT) {
    for (const period of SPEND_PERIOD_LADDER) {
      const start = startOfSpendPeriod(sample.unix, period)
      const next = startOfNextSpendPeriod(sample.unix, period)
      assert.ok(start <= sample.unix)
      assert.ok(next > sample.unix)
      assert.equal(startOfSpendPeriod(start, period), start)
      assert.equal(startOfSpendPeriod(next, period), next)
    }
  }
})

test("the smallest containing window is chosen so a cap cannot refresh inside a session", () => {
  const hourAligned = 1_759_996_800
  const within = smallestSpendWindowContaining(hourAligned, hourAligned + 3_599)
  assert.ok(within)
  assert.equal(within.period, "hour")
  assert.equal(within.periodStartUnix, hourAligned)
  assert.equal(within.periodEndUnix, hourAligned + 3_600)

  const straddlesHour = smallestSpendWindowContaining(hourAligned + 3_599, hourAligned + 3_601)
  assert.ok(straddlesHour)
  assert.equal(straddlesHour.period, "day")
  assert.ok(straddlesHour.periodEndUnix > hourAligned + 3_601)
})

test("a session straddling a year boundary escalates instead of keeping a refreshing window", () => {
  const lastSecondOf2025 = 1_767_225_599
  const escalated = smallestSpendWindowContaining(lastSecondOf2025, lastSecondOf2025 + 2)
  assert.ok(escalated)
  assert.equal(escalated.period, "week")
  assert.ok(escalated.periodEndUnix > lastSecondOf2025 + 2)
})

test("a session straddling a year boundary that is also a week boundary has no containing window", () => {
  const mondayNewYear2029 = 1_861_920_000
  assert.equal(startOfSpendPeriod(mondayNewYear2029, "week"), mondayNewYear2029)
  assert.equal(startOfSpendPeriod(mondayNewYear2029, "year"), mondayNewYear2029)
  assert.equal(smallestSpendWindowContaining(mondayNewYear2029 - 1, mondayNewYear2029 + 1), null)
})

test("a window that ends before it starts is rejected", () => {
  assert.throws(() => smallestSpendWindowContaining(1_760_000_000, 1_759_999_999), RangeError)
})

test("fractional or negative seconds are rejected rather than floored silently", () => {
  assert.throws(() => startOfSpendPeriod(1_760_000_000.5, "hour"), RangeError)
  assert.throws(() => startOfSpendPeriod(-1, "hour"), RangeError)
})
