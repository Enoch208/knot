import type { ExpectedPublicSeller } from "../../discovery/src/public-sellers.ts"

const historicalHealthGuardCardSha256 = "c5cde2e972ac97d42404705f59a3dc46a2c7b73b650f9334a7642f90e3889f02"

export function capturedSellerName(seller: ExpectedPublicSeller, bodySha256: string): string {
  return seller.key === "healthguard" && bodySha256 === historicalHealthGuardCardSha256
    ? "healthguard-agent"
    : seller.cardName
}
