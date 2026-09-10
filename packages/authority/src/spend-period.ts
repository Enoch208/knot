export type SpendPeriod = "minute" | "hour" | "day" | "week" | "month" | "year"

export const SPEND_PERIOD_CODES = {
  minute: 0,
  hour: 1,
  day: 2,
  week: 3,
  month: 4,
  year: 5,
} as const satisfies Record<SpendPeriod, number>

export const SPEND_PERIOD_LADDER = ["minute", "hour", "day", "week", "month", "year"] as const

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3_600
const SECONDS_PER_DAY = 86_400
const EPOCH_WEEKDAY_OFFSET_DAYS = 4

const floorDivide = (value: number, divisor: number): number => Math.floor(value / divisor)

const requireWholeSeconds = (unixSeconds: number): number => {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new RangeError("a spend period boundary needs whole non-negative unix seconds")
  }
  return unixSeconds
}

const startOfUtcMonth = (unixSeconds: number): number => {
  const at = new Date(unixSeconds * 1000)
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000
}

const startOfUtcYear = (unixSeconds: number): number => {
  const at = new Date(unixSeconds * 1000)
  return Date.UTC(at.getUTCFullYear(), 0, 1) / 1000
}

export function startOfSpendPeriod(unixSeconds: number, period: SpendPeriod): number {
  const seconds = requireWholeSeconds(unixSeconds)
  switch (period) {
    case "minute":
      return floorDivide(seconds, SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE
    case "hour":
      return floorDivide(seconds, SECONDS_PER_HOUR) * SECONDS_PER_HOUR
    case "day":
      return floorDivide(seconds, SECONDS_PER_DAY) * SECONDS_PER_DAY
    case "week": {
      const dayIndex = floorDivide(seconds, SECONDS_PER_DAY)
      const weekdayOffset = (((dayIndex - EPOCH_WEEKDAY_OFFSET_DAYS) % 7) + 7) % 7
      return (dayIndex - weekdayOffset) * SECONDS_PER_DAY
    }
    case "month":
      return startOfUtcMonth(seconds)
    case "year":
      return startOfUtcYear(seconds)
  }
}

export function startOfNextSpendPeriod(unixSeconds: number, period: SpendPeriod): number {
  const start = startOfSpendPeriod(unixSeconds, period)
  switch (period) {
    case "minute":
      return start + SECONDS_PER_MINUTE
    case "hour":
      return start + SECONDS_PER_HOUR
    case "day":
      return start + SECONDS_PER_DAY
    case "week":
      return start + 7 * SECONDS_PER_DAY
    case "month": {
      const at = new Date(start * 1000)
      return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) / 1000
    }
    case "year": {
      const at = new Date(start * 1000)
      return Date.UTC(at.getUTCFullYear() + 1, 0, 1) / 1000
    }
  }
}

export interface SpendWindow {
  period: SpendPeriod
  periodCode: number
  periodStartUnix: number
  periodEndUnix: number
}

export function smallestSpendWindowContaining(
  startUnix: number,
  endUnix: number,
): SpendWindow | null {
  if (requireWholeSeconds(endUnix) < requireWholeSeconds(startUnix)) {
    throw new RangeError("a spend window cannot end before it starts")
  }
  for (const period of SPEND_PERIOD_LADDER) {
    const periodStartUnix = startOfSpendPeriod(startUnix, period)
    if (periodStartUnix !== startOfSpendPeriod(endUnix, period)) continue
    return {
      period,
      periodCode: SPEND_PERIOD_CODES[period],
      periodStartUnix,
      periodEndUnix: startOfNextSpendPeriod(startUnix, period),
    }
  }
  return null
}
