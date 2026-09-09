import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import {
  claimed,
  freshnessSeconds,
  labeledValue,
  live,
  onchain,
  provenance,
  unavailable,
} from "../../packages/provenance/src/provenance.ts"

const numericMetric = labeledValue(z.number())
const OBSERVED = "2026-09-09T09:00:00.000Z"
const NOW = "2026-09-09T09:02:30.000Z"

test("a live metric carries its source and survives the closed schema", () => {
  const entry = live(12.5, "8004scan/agents", OBSERVED, "https://8004scan.io/api/v1/agents")
  const parsed = numericMetric.parse(entry)
  assert.equal(parsed.value, 12.5)
  assert.equal(parsed.provenance.label, "LIVE")
  assert.equal(parsed.provenance.source, "8004scan/agents")
})

test("an onchain metric must carry chain and block", () => {
  const entry = onchain(1n.toString(), "venus/comptroller", OBSERVED, 56, 120_000_000n)
  const parsed = labeledValue(z.string()).parse(entry)
  assert.equal(parsed.provenance.chainId, 56)
  assert.equal(parsed.provenance.blockNumber, "120000000")
})

test("an onchain label without a block number is rejected", () => {
  assert.throws(() =>
    provenance.parse({
      label: "ONCHAIN",
      source: "venus/comptroller",
      observedAtUtc: OBSERVED,
      chainId: 56,
      blockNumber: null,
      uri: null,
      unavailableReason: null,
    }),
  )
})

test("an unavailable metric carries a reason and no value", () => {
  const entry = unavailable("venus/oracle", "oracle read reverted", OBSERVED)
  const parsed = numericMetric.parse(entry)
  assert.equal(parsed.value, null)
  assert.equal(parsed.provenance.unavailableReason, "oracle read reverted")
})

test("an unavailable metric may not smuggle a zero value", () => {
  const smuggled = {
    value: 0,
    provenance: {
      label: "UNAVAILABLE",
      source: "venus/oracle",
      observedAtUtc: OBSERVED,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: "oracle read reverted",
    },
  }
  assert.throws(() => numericMetric.parse(smuggled), /must not carry a value/)
})

test("a null value may not be presented as live", () => {
  const mislabeled = {
    value: null,
    provenance: {
      label: "LIVE",
      source: "venus/oracle",
      observedAtUtc: OBSERVED,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: null,
    },
  }
  assert.throws(() => numericMetric.parse(mislabeled), /must be labeled UNAVAILABLE/)
})

test("an unavailable label without a reason is rejected", () => {
  assert.throws(() =>
    provenance.parse({
      label: "UNAVAILABLE",
      source: "venus/oracle",
      observedAtUtc: OBSERVED,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: null,
    }),
  )
})

test("only an unavailable label may carry an unavailable reason", () => {
  assert.throws(() =>
    provenance.parse({
      label: "CLAIMED",
      source: "publisher",
      observedAtUtc: OBSERVED,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: "not really",
    }),
  )
})

test("a publisher claim is never promoted to live", () => {
  const entry = claimed("2 second median", "agent-card", OBSERVED)
  const parsed = labeledValue(z.string()).parse(entry)
  assert.equal(parsed.provenance.label, "CLAIMED")
})

test("freshness is reported in whole seconds and withheld when unavailable", () => {
  assert.equal(freshnessSeconds(live(1, "src", OBSERVED), NOW), 150)
  assert.equal(freshnessSeconds(unavailable("src", "reason", OBSERVED), NOW), null)
})

test("unknown provenance fields are rejected", () => {
  assert.throws(() =>
    provenance.parse({
      label: "LIVE",
      source: "src",
      observedAtUtc: OBSERVED,
      chainId: null,
      blockNumber: null,
      uri: null,
      unavailableReason: null,
      trustMe: true,
    }),
  )
})
