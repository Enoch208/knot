import assert from "node:assert/strict"
import { test } from "node:test"
import { expectedPublicSellers } from "../../packages/discovery/src/public-sellers.ts"
import { capturedSellerName } from "../../packages/reliability/src/captured-seller-name.ts"

test("historical HealthGuard name is limited to its exact retained card digest", () => {
  const health = expectedPublicSellers.find(seller => seller.key === "healthguard")!
  const oldDigest = "c5cde2e972ac97d42404705f59a3dc46a2c7b73b650f9334a7642f90e3889f02"
  assert.equal(capturedSellerName(health, oldDigest), "healthguard-agent")
  assert.equal(capturedSellerName(health, "0".repeat(64)), "KNOT HealthGuard")
  assert.equal(capturedSellerName(expectedPublicSellers[1]!, oldDigest), "KNOT RangePilot")
})
