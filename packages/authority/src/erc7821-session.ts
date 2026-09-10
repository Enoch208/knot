import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem"

export const ERC7821_BATCH_MODE =
  "0x0100000000007821000100000000000000000000000000000000000000000000" as const

export const SET_CAN_EXECUTE = "setCanExecute(bytes32,address,bytes4,bool)" as const
export const SET_SPEND_LIMIT = "setSpendLimit(bytes32,address,uint8,uint256)" as const
export const REVOKE_KEY = "revoke(bytes32)" as const

export type SpendPeriodCode = 0 | 1 | 2 | 3 | 4 | 5

export interface InnerCall {
  to: Address
  value: bigint
  data: Hex
}

export interface AllowedCall {
  target: Address
  selector: Hex
}

export interface TokenLimit {
  token: Address
  periodCode: SpendPeriodCode
  limitBaseUnits: bigint
}

export class SessionCallError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "SessionCallError"
    this.code = code
  }
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const

const setCanExecuteAbi = [
  {
    type: "function",
    name: "setCanExecute",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "can", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

const setSpendLimitAbi = [
  {
    type: "function",
    name: "setSpendLimit",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "period", type: "uint8" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

const revokeAbi = [
  {
    type: "function",
    name: "revoke",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

const assertKeyHash = (keyHash: Hex): void => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyHash)) {
    throw new SessionCallError("KEY_HASH_INVALID", "keyHash must be 32 bytes")
  }
}

const assertSelector = (selector: Hex): void => {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) {
    throw new SessionCallError("SELECTOR_INVALID", `selector ${selector} must be exactly 4 bytes`)
  }
  if (selector === "0x00000000") {
    throw new SessionCallError("SELECTOR_WILDCARD", "a zero selector would authorise every function")
  }
}

export function buildGrantCalls(
  account: Address,
  keyHash: Hex,
  allowed: readonly AllowedCall[],
  tokenLimits: readonly TokenLimit[],
  nativeLimitWei: bigint,
  nativeCeilingWei: bigint,
  nativePeriodCode: SpendPeriodCode,
): InnerCall[] {
  assertKeyHash(keyHash)
  if (allowed.length === 0) {
    throw new SessionCallError("NO_ALLOWED_CALLS", "a session with no allowed call cannot act and must not be granted")
  }
  if (nativeLimitWei > nativeCeilingWei) {
    throw new SessionCallError(
      "NATIVE_LIMIT_ABOVE_CEILING",
      `native limit ${nativeLimitWei} exceeds the proven ceiling ${nativeCeilingWei}`,
    )
  }

  const seen = new Set<string>()
  const calls: InnerCall[] = []

  for (const entry of allowed) {
    assertSelector(entry.selector)
    const key = `${entry.target.toLowerCase()}:${entry.selector.toLowerCase()}`
    if (seen.has(key)) {
      throw new SessionCallError("DUPLICATE_ALLOWED_CALL", `${key} is authorised twice`)
    }
    seen.add(key)
    calls.push({
      to: account,
      value: 0n,
      data: encodeFunctionData({
        abi: setCanExecuteAbi,
        functionName: "setCanExecute",
        args: [keyHash, entry.target, entry.selector, true],
      }),
    })
  }

  for (const limit of tokenLimits) {
    if (limit.limitBaseUnits <= 0n) {
      throw new SessionCallError("TOKEN_LIMIT_NOT_POSITIVE", "a token spend cap must be positive")
    }
    if (limit.token === NATIVE_TOKEN) {
      throw new SessionCallError("TOKEN_IS_NATIVE", "use the native limit for the zero address")
    }
    calls.push({
      to: account,
      value: 0n,
      data: encodeFunctionData({
        abi: setSpendLimitAbi,
        functionName: "setSpendLimit",
        args: [keyHash, limit.token, limit.periodCode, limit.limitBaseUnits],
      }),
    })
  }

  calls.push({
    to: account,
    value: 0n,
    data: encodeFunctionData({
      abi: setSpendLimitAbi,
      functionName: "setSpendLimit",
      args: [keyHash, NATIVE_TOKEN, nativePeriodCode, nativeLimitWei],
    }),
  })

  return calls
}

export function buildRevokeCalls(account: Address, keyHash: Hex): InnerCall[] {
  assertKeyHash(keyHash)
  return [
    {
      to: account,
      value: 0n,
      data: encodeFunctionData({ abi: revokeAbi, functionName: "revoke", args: [keyHash] }),
    },
  ]
}

export function encodeErc7821Execute(calls: readonly InnerCall[]): Hex {
  if (calls.length === 0) {
    throw new SessionCallError("EMPTY_BATCH", "an ERC-7821 batch must contain at least one call")
  }
  const executionData = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [calls.map((call) => ({ to: call.to, value: call.value, data: call.data }))],
  )
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "execute",
        inputs: [
          { name: "mode", type: "bytes32" },
          { name: "executionData", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "payable",
      },
    ],
    functionName: "execute",
    args: [ERC7821_BATCH_MODE, executionData],
  })
}

export const selectorOf = (signature: string): Hex => toFunctionSelector(signature)

export const SECP256K1_KEY_TYPE = 2 as const

export function sessionPublicKeyFromAddress(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 })
}

export function deriveKeyHash(keyType: number, publicKey: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }],
      [keyType, keccak256(publicKey)],
    ),
  )
}

const authorizeAbi = [
  {
    type: "function",
    name: "authorize",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

export function buildAuthorizeCall(
  account: Address,
  expiryUnix: number,
  publicKey: Hex,
): InnerCall {
  if (!Number.isSafeInteger(expiryUnix) || expiryUnix <= 0) {
    throw new SessionCallError("EXPIRY_INVALID", "session expiry must be a positive unix timestamp")
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(publicKey)) {
    throw new SessionCallError("PUBLIC_KEY_INVALID", "a secp256k1 session public key must be 32 bytes")
  }
  return {
    to: account,
    value: 0n,
    data: encodeFunctionData({
      abi: authorizeAbi,
      functionName: "authorize",
      args: [
        { expiry: expiryUnix, keyType: SECP256K1_KEY_TYPE, isSuperAdmin: false, publicKey },
      ],
    }),
  }
}
