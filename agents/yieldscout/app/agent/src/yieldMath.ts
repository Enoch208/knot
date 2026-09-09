const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000n;

export function annualRateRay(ratePerPeriodRay: string, periodsPerYear: string): bigint {
  return BigInt(ratePerPeriodRay) * BigInt(periodsPerYear);
}

export function horizonBenefitUnits(
  amountUnits: string,
  annualRate: bigint,
  holdingHorizonSeconds: number,
): bigint {
  return (
    BigInt(amountUnits) * annualRate * BigInt(holdingHorizonSeconds)
  ) / (RAY * SECONDS_PER_YEAR);
}

export function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
