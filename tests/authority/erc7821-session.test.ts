import assert from "node:assert/strict"
import { test } from "node:test"
import type { Address, Hex } from "viem"
import {
  ERC7821_BATCH_MODE,
  SessionCallError,
  buildGrantCalls,
  buildRevokeCalls,
  encodeErc7821Execute,
  type AllowedCall,
  type TokenLimit,
} from "../../packages/authority/src/erc7821-session.ts"

const ACCOUNT = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930" as Address
const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE" as Address
const ROUTER = "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25" as Address
const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" as Address
const KEY_HASH = `0x${"ab".repeat(32)}` as Hex
const CEILING = 5_000_000_000_000_000n

const allowed: AllowedCall[] = [
  { target: COMMERCE, selector: "0x41528812" },
  { target: ROUTER, selector: "0x51d5456d" },
  { target: COMMERCE, selector: "0xdd4ae9d4" },
  { target: TOKEN, selector: "0x095ea7b3" },
  { target: COMMERCE, selector: "0xd2e13f50" },
]

const tokenLimits: TokenLimit[] = [
  { token: TOKEN, periodCode: 2, limitBaseUnits: 100_000_000_000_000_000n },
]

const grant = (
  calls: readonly AllowedCall[] = allowed,
  limits: readonly TokenLimit[] = tokenLimits,
  nativeWei = CEILING,
) => buildGrantCalls(ACCOUNT, KEY_HASH, calls, limits, nativeWei, CEILING, 2)

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof SessionCallError, `expected SessionCallError, got ${String(error)}`)
    return error.code
  }
  return assert.fail("expected a refusal")
}

test("the grant encodes one setCanExecute per allowed call plus both spend limits", () => {
  const calls = grant()
  assert.equal(calls.length, allowed.length + tokenLimits.length + 1)
  for (let index = 0; index < allowed.length; index += 1) {
    assert.equal(calls[index]?.data.slice(0, 10), "0x136a12f7")
  }
  assert.equal(calls[allowed.length]?.data.slice(0, 10), "0x598daac4")
  assert.equal(calls.at(-1)?.data.slice(0, 10), "0x598daac4")
  for (const call of calls) {
    assert.equal(call.to, ACCOUNT)
    assert.equal(call.value, 0n)
  }
})

test("the outer batch matches the ERC-7821 selector and mode observed on chain", () => {
  const encoded = encodeErc7821Execute(grant())
  assert.equal(encoded.slice(0, 10), "0xe9ae5c53")
  assert.ok(encoded.includes(ERC7821_BATCH_MODE.slice(2)))
})

test("revoke encodes the selector observed in the recorded revoke transaction", () => {
  const calls = buildRevokeCalls(ACCOUNT, KEY_HASH)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.data.slice(0, 10), "0xb75c7dc6")
})

test("a session with no allowed call is refused rather than granted", () => {
  assert.equal(refusal(() => grant([])), "NO_ALLOWED_CALLS")
})

test("a zero selector is refused because it would authorise every function", () => {
  assert.equal(
    refusal(() => grant([{ target: COMMERCE, selector: "0x00000000" }])),
    "SELECTOR_WILDCARD",
  )
})

test("a malformed selector is refused rather than padded", () => {
  assert.equal(refusal(() => grant([{ target: COMMERCE, selector: "0x4152" as Hex }])), "SELECTOR_INVALID")
})

test("the same target and selector cannot be authorised twice", () => {
  assert.equal(
    refusal(() => grant([...allowed, { target: COMMERCE, selector: "0x41528812" }])),
    "DUPLICATE_ALLOWED_CALL",
  )
})

test("a native limit above the proven ceiling is refused", () => {
  assert.equal(refusal(() => grant(allowed, tokenLimits, CEILING + 1n)), "NATIVE_LIMIT_ABOVE_CEILING")
})

test("a non-positive token cap is refused", () => {
  assert.equal(
    refusal(() => grant(allowed, [{ token: TOKEN, periodCode: 2, limitBaseUnits: 0n }])),
    "TOKEN_LIMIT_NOT_POSITIVE",
  )
})

test("the native zero address cannot be passed as a token cap", () => {
  assert.equal(
    refusal(() =>
      grant(allowed, [
        { token: "0x0000000000000000000000000000000000000000", periodCode: 2, limitBaseUnits: 1n },
      ]),
    ),
    "TOKEN_IS_NATIVE",
  )
})

test("a malformed key hash is refused by both builders", () => {
  assert.equal(
    refusal(() => buildGrantCalls(ACCOUNT, "0xdead" as Hex, allowed, tokenLimits, CEILING, CEILING, 2)),
    "KEY_HASH_INVALID",
  )
  assert.equal(refusal(() => buildRevokeCalls(ACCOUNT, "0xdead" as Hex)), "KEY_HASH_INVALID")
})

test("an empty batch cannot be encoded", () => {
  assert.equal(refusal(() => encodeErc7821Execute([])), "EMPTY_BATCH")
})
