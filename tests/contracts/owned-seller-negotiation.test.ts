import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildOwnedSellerNegotiationRequest,
  isOwnedSellerCategory,
  ownedSellerTerms,
  type OwnedSellerCategory,
} from "../../packages/contracts/src/owned-seller-negotiation.ts"

const categories: readonly OwnedSellerCategory[] = ["health", "rebalancing", "grid", "yield"]

describe("owned seller negotiation request", () => {
  it("builds the replay-bound nested request for every owned finance category", () => {
    for (const category of categories) {
      const value = buildOwnedSellerNegotiationRequest({
        category,
        serviceRequestId: `request_${category}`,
        taskDescription: `description-${category}`,
      })
      assert.deepEqual(value, {
        skill: "negotiate",
        request: {
          task_description: `description-${category}`,
          terms: ownedSellerTerms(category),
          request_id: `request_${category}`,
        },
      })
      assert.equal("request_id" in value, false)
    }
  })

  it("does not classify the unsupported security category as an owned seller", () => {
    assert.equal(isOwnedSellerCategory("security"), false)
    assert.equal(isOwnedSellerCategory("health"), true)
  })

  it("returns a fresh terms object so callers cannot mutate the sealed mapping", () => {
    const first = ownedSellerTerms("rebalancing")
    const second = ownedSellerTerms("rebalancing")
    first.deliverables = "changed"
    assert.notEqual(first.deliverables, second.deliverables)
  })
})
