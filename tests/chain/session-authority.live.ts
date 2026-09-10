import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createPublicClient, decodeAbiParameters, http, type Hex } from "viem"
import {
  SECP256K1_KEY_TYPE,
  buildAuthorizeCall,
  deriveKeyHash,
  sessionPublicKeyFromAddress,
} from "../../packages/authority/src/erc7821-session.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const RPC = process.env.KNOT_LIVE_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com"
const GRANT_TX = "0x8bd4658b6690088edcefd31decd22128376daa7820910d408822a2be010047c2" as Hex
const ACCOUNT = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930" as const

const BATCH = [
  {
    type: "tuple[]",
    components: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const

const readGrantBatch = async () => {
  const client = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) })
  const transaction = await client.getTransaction({ hash: GRANT_TX })
  const [, executionData] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }],
    `0x${transaction.input.slice(10)}`,
  )
  const [calls] = decodeAbiParameters(BATCH, executionData)
  return calls
}

test("the pinned authorize calldata still equals the transaction this account accepted", async () => {
  const calls = await readGrantBatch()
  const onChain = calls[1]?.data.toLowerCase()
  assert.ok(onChain, "the recorded grant no longer contains an authorize call")

  const source = await readFile(join(ROOT, "tests", "authority", "erc7821-session.test.ts"), "utf8")
  const pinned = source.match(/RECORDED_AUTHORIZE_CALLDATA =\s*\n\s*"(0x[0-9a-f]+)"/)?.[1]
  assert.ok(pinned, "the deterministic suite no longer pins authorize calldata")
  assert.equal(
    pinned.toLowerCase(),
    onChain,
    "the pinned calldata has drifted from the on-chain grant and no longer proves the encoder",
  )
})

test("the encoder reproduces the on-chain authorize calldata from first principles", async () => {
  const calls = await readGrantBatch()
  const onChain = calls[1]?.data.toLowerCase()
  assert.ok(onChain)

  const [key] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    `0x${onChain.slice(10)}`,
  )

  const rebuilt = buildAuthorizeCall(ACCOUNT, Number(key.expiry), key.publicKey)
  assert.equal(rebuilt.data.toLowerCase(), onChain)
  assert.equal(key.isSuperAdmin, false)
  assert.equal(key.keyType, SECP256K1_KEY_TYPE)
})

test("the derived key hash equals the hash setCanExecute referenced in the same batch", async () => {
  const calls = await readGrantBatch()
  const authorizeData = calls[1]?.data
  const setCanExecuteData = calls[2]?.data
  assert.ok(authorizeData && setCanExecuteData)

  const [key] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    `0x${authorizeData.slice(10)}`,
  )
  const [onChainKeyHash] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "bytes4" }, { type: "bool" }],
    `0x${setCanExecuteData.slice(10)}`,
  )

  assert.equal(deriveKeyHash(key.keyType, key.publicKey), onChainKeyHash)
  assert.equal(deriveKeyHash(key.keyType, sessionPublicKeyFromAddress(`0x${key.publicKey.slice(26)}`)), onChainKeyHash)
})
