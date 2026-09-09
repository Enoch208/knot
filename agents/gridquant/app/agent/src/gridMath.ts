export const powerOfTen = (decimals: number): bigint => 10n ** BigInt(decimals);

const integerRootFloor = (value: bigint, degree: number): bigint => {
  if (value < 2n || degree === 1) return value;
  const exponent = BigInt(degree);
  const bitLength = value.toString(2).length;
  let estimate = 1n << BigInt(Math.ceil(bitLength / degree));
  while (true) {
    const next =
      (BigInt(degree - 1) * estimate + value / estimate ** (exponent - 1n)) /
      exponent;
    if (next >= estimate) return estimate;
    estimate = next;
  }
};

export const arithmeticLevels = (lower: bigint, upper: bigint, count: number): bigint[] => {
  const intervals = BigInt(count - 1);
  return Array.from({ length: count }, (_, index) =>
    lower + ((upper - lower) * BigInt(index)) / intervals,
  );
};

export const geometricLevels = (lower: bigint, upper: bigint, count: number): bigint[] => {
  const intervals = count - 1;
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return lower;
    if (index === intervals) return upper;
    const target = lower ** BigInt(intervals - index) * upper ** BigInt(index);
    return integerRootFloor(target, intervals);
  });
};

export const allocateUnits = (total: bigint, count: number): bigint[] => {
  const divisor = BigInt(count);
  const each = total / divisor;
  const remainder = total % divisor;
  return Array.from({ length: count }, (_, index) =>
    each + (BigInt(index) < remainder ? 1n : 0n),
  );
};

export const quoteToBaseUnits = (
  quoteUnits: bigint,
  priceUnits: bigint,
  priceDecimals: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint =>
  (quoteUnits * powerOfTen(baseDecimals) * powerOfTen(priceDecimals)) /
  (powerOfTen(quoteDecimals) * priceUnits);

export const ceilDivide = (numerator: bigint, denominator: bigint): bigint =>
  numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
