export function gridArithmeticLevels(lower: bigint, upper: bigint, count: number): bigint[] {
  const intervals = BigInt(count - 1)
  return Array.from({ length: count }, (_, index) => lower + (upper - lower) * BigInt(index) / intervals)
}

export function gridGeometricLevels(lower: bigint, upper: bigint, count: number): bigint[] {
  const intervals = count - 1
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return lower
    if (index === intervals) return upper
    return integerRootFloor(lower ** BigInt(intervals - index) * upper ** BigInt(index), intervals)
  })
}

export function gridAllocateUnits(total: bigint, count: number): bigint[] {
  const divisor = BigInt(count)
  const each = total / divisor
  const remainder = total % divisor
  return Array.from({ length: count }, (_, index) => each + (BigInt(index) < remainder ? 1n : 0n))
}

export function gridQuoteToBase(quoteUnits: bigint, priceUnits: bigint, priceDecimals: number, baseDecimals: number, quoteDecimals: number): bigint {
  return quoteUnits * 10n ** BigInt(baseDecimals) * 10n ** BigInt(priceDecimals) / (10n ** BigInt(quoteDecimals) * priceUnits)
}

export function gridCeilDivide(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator
}

function integerRootFloor(value: bigint, degree: number): bigint {
  if (value < 2n || degree === 1) return value
  const exponent = BigInt(degree)
  let estimate = 1n << BigInt(Math.ceil(value.toString(2).length / degree))
  while (true) {
    const next = (BigInt(degree - 1) * estimate + value / estimate ** (exponent - 1n)) / exponent
    if (next >= estimate) return estimate
    estimate = next
  }
}
