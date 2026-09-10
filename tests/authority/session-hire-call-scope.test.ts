import assert from "node:assert/strict"
import { test } from "node:test"
import { encodeFunctionData, toFunctionSelector } from "viem"
import {
  ANY_SELECTOR_SENTINEL,
  ANY_TARGET_SENTINEL,
  EMPTY_CALLDATA_SELECTOR,
} from "../../packages/authority/src/index.ts"
import type { PreparedHire } from "../../packages/commerce/src/hire-envelope.ts"
import {
  COMMERCE,
  PAYMENT_TOKEN,
  UNLISTED_CONTRACT,
  callAt,
  refusalCode,
  replaceCall,
} from "./hire-fixtures.ts"

const APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

const TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const

const FUND_ABI = [
  {
    name: "fund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "expectedBudget", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
] as const

const indexOfSelector = (prepared: PreparedHire, signature: string): number => {
  const index = prepared.calls.findIndex((call) => call.data.startsWith(toFunctionSelector(signature)))
  assert.ok(index >= 0, `the prepared hire carries no ${signature} call`)
  return index
}

test("a wildcard target sentinel in the prepared calls is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), to: ANY_TARGET_SENTINEL }),
    })),
    "WILDCARD_TARGET",
  )
})

test("a wildcard selector sentinel in the prepared calldata is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), data: ANY_SELECTOR_SENTINEL }),
    })),
    "WILDCARD_SELECTOR",
  )
})

test("the empty-calldata sentinel is refused rather than scoped as a call", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), data: EMPTY_CALLDATA_SELECTOR }),
    })),
    "EMPTY_CALLDATA_SELECTOR",
  )
})

test("calldata with no four-byte selector is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), data: "0x" }),
    })),
    "SELECTOR_MISSING",
  )
})

test("a call target outside the pinned manifest contract set is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), to: UNLISTED_CONTRACT }),
    })),
    "TARGET_OUTSIDE_MANIFEST",
  )
})

test("a prepared call that would send native value is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: replaceCall(prepared, 0, { ...callAt(prepared, 0), value: "1" }),
    })),
    "CALL_CARRIES_NATIVE_VALUE",
  )
})

test("an approval for more than the hire budget is refused", () => {
  assert.equal(
    refusalCode((prepared) => {
      const index = indexOfSelector(prepared, "approve(address,uint256)")
      return {
        prepared: replaceCall(prepared, index, {
          ...callAt(prepared, index),
          data: encodeFunctionData({
            abi: APPROVE_ABI,
            functionName: "approve",
            args: [COMMERCE, BigInt(prepared.envelope.budgetBaseUnits) * 2n],
          }),
        }),
      }
    }),
    "APPROVAL_AMOUNT_NOT_BUDGET",
  )
})

test("an approval naming a spender other than the commerce kernel is refused", () => {
  assert.equal(
    refusalCode((prepared) => {
      const index = indexOfSelector(prepared, "approve(address,uint256)")
      return {
        prepared: replaceCall(prepared, index, {
          ...callAt(prepared, index),
          data: encodeFunctionData({
            abi: APPROVE_ABI,
            functionName: "approve",
            args: [UNLISTED_CONTRACT, BigInt(prepared.envelope.budgetBaseUnits)],
          }),
        }),
      }
    }),
    "APPROVAL_SPENDER_NOT_COMMERCE",
  )
})

test("a payment-token call that transfers instead of approving is refused", () => {
  assert.equal(
    refusalCode((prepared) => {
      const index = indexOfSelector(prepared, "approve(address,uint256)")
      return {
        prepared: replaceCall(prepared, index, {
          ...callAt(prepared, index),
          data: encodeFunctionData({
            abi: TRANSFER_ABI,
            functionName: "transfer",
            args: [UNLISTED_CONTRACT, BigInt(prepared.envelope.budgetBaseUnits)],
          }),
        }),
      }
    }),
    "TOKEN_CALL_NOT_APPROVAL",
  )
})

test("a second payment-token call is refused rather than folded into one permission", () => {
  assert.equal(
    refusalCode((prepared) => {
      const approvalIndex = indexOfSelector(prepared, "approve(address,uint256)")
      const registerIndex = indexOfSelector(prepared, "registerJob(uint256,address)")
      return {
        prepared: replaceCall(prepared, registerIndex, {
          ...callAt(prepared, approvalIndex),
          to: PAYMENT_TOKEN,
        }),
      }
    }),
    "TOKEN_CALL_COUNT_UNEXPECTED",
  )
})

test("a funding call moving more than the hire budget is refused", () => {
  assert.equal(
    refusalCode((prepared) => {
      const index = indexOfSelector(prepared, "fund(uint256,uint256,bytes)")
      return {
        prepared: replaceCall(prepared, index, {
          ...callAt(prepared, index),
          data: encodeFunctionData({
            abi: FUND_ABI,
            functionName: "fund",
            args: [BigInt(prepared.envelope.jobId), BigInt(prepared.envelope.budgetBaseUnits) + 1n, "0x"],
          }),
        }),
      }
    }),
    "FUND_AMOUNT_NOT_BUDGET",
  )
})

test("a funding call naming another job is refused", () => {
  assert.equal(
    refusalCode((prepared) => {
      const index = indexOfSelector(prepared, "fund(uint256,uint256,bytes)")
      return {
        prepared: replaceCall(prepared, index, {
          ...callAt(prepared, index),
          data: encodeFunctionData({
            abi: FUND_ABI,
            functionName: "fund",
            args: [BigInt(prepared.envelope.jobId) + 1n, BigInt(prepared.envelope.budgetBaseUnits), "0x"],
          }),
        }),
      }
    }),
    "FUND_JOB_ID_MISMATCH",
  )
})

test("a hire that never funds the job is refused rather than scoped as a spending session", () => {
  assert.equal(
    refusalCode((prepared) => {
      const budgetIndex = indexOfSelector(prepared, "setBudget(uint256,uint256,bytes)")
      const fundIndex = indexOfSelector(prepared, "fund(uint256,uint256,bytes)")
      return { prepared: replaceCall(prepared, fundIndex, callAt(prepared, budgetIndex)) }
    }),
    "FUND_CALL_COUNT_UNEXPECTED",
  )
})

test("an envelope with a zero budget cannot scope a spending session", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: { envelope: { ...prepared.envelope, budgetBaseUnits: "0" }, calls: prepared.calls },
    })),
    "BUDGET_NOT_POSITIVE",
  )
})

test("a hire with no prepared calls is refused rather than granted an empty session", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: { envelope: { ...prepared.envelope, callCount: 0 }, calls: [] },
    })),
    "NO_CALLS_TO_SCOPE",
  )
})

test("a prepared call list that disagrees with the envelope call count is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: { envelope: prepared.envelope, calls: prepared.calls.slice(0, 4) },
    })),
    "CALL_COUNT_MISMATCH",
  )
})

test("an envelope naming a commerce kernel off the pinned manifest is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: { envelope: { ...prepared.envelope, commerce: UNLISTED_CONTRACT }, calls: prepared.calls },
    })),
    "ENVELOPE_CONTRACT_OFF_MANIFEST",
  )
})

test("an envelope naming a payment token off the pinned manifest is refused", () => {
  assert.equal(
    refusalCode((prepared) => ({
      prepared: { envelope: { ...prepared.envelope, paymentToken: UNLISTED_CONTRACT }, calls: prepared.calls },
    })),
    "ENVELOPE_CONTRACT_OFF_MANIFEST",
  )
})
