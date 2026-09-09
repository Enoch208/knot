import {
  createFetchPublicSellerReader,
  expectedPublicSellers,
  verifyPublicSeller,
} from "../packages/discovery/src/public-sellers.ts"

const reader = createFetchPublicSellerReader()
const results = await Promise.all(expectedPublicSellers.map((expected) => verifyPublicSeller(reader, expected)))
for (const result of results) {
  process.stdout.write(`${result.key.padEnd(12)} ${result.outcome.padEnd(11)} card=${result.cardStatus ?? "-"} proof=${result.registrationStatus ?? "-"} unauth=${result.unauthenticatedInvokeStatus ?? "-"}\n`)
  for (const error of result.errors) process.stdout.write(`  ${error}\n`)
}
if (results.some((result) => result.outcome !== "VERIFIED")) process.exitCode = 1
