#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { bscTestnet } from "viem/chains"
import {
  buildAuthorizeCall,
  buildGrantCalls,
  buildRevokeCalls,
  decryptKeystore,
  deriveKeyHash,
  encodeErc7821Execute,
  sessionPublicKeyFromAddress,
  SECP256K1_KEY_TYPE,
  type AllowedCall,
  type TokenLimit,
} from "../packages/authority/src/index.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE = join(ROOT, ".secrets", "session-hire-state.json")
const KEYSTORE = join(
  ROOT, ".secrets", "buyer", ".studio", "wallets",
  "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930.json",
)
const ENV_FILE = join(ROOT, ".secrets", "buyer", ".studio", ".env.local")

const ACCOUNT = "0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930" as Address
const COMMERCE = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE" as Address
const ROUTER = "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25" as Address
const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" as Address
const RPC = process.env.KNOT_TESTNET_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com"

const BUDGET = 100_000_000_000_000_000n
const NATIVE_CEILING = 5_000_000_000_000_000n
const DAY_PERIOD = 2 as const
const SESSION_SECONDS = 3600

const ALLOWED: AllowedCall[] = [
  { target: COMMERCE, selector: "0x41528812" },
  { target: ROUTER, selector: "0x51d5456d" },
  { target: COMMERCE, selector: "0xdd4ae9d4" },
  { target: TOKEN, selector: "0x095ea7b3" },
  { target: COMMERCE, selector: "0xd2e13f50" },
]

const TOKEN_LIMITS: TokenLimit[] = [
  { token: TOKEN, periodCode: DAY_PERIOD, limitBaseUnits: BUDGET },
]

interface SessionState {
  sessionAddress: Address
  sessionPrivateKey: Hex
  keyHash: Hex
  expiryUnix: number
  grantTransactionHash?: Hex
  revokeTransactionHash?: Hex
}

const execute = process.argv.includes("--execute")
const phase = process.argv[2] ?? "plan"
const out = (line: string) => process.stderr.write(`${line}\n`)

async function password(): Promise<string> {
  const fromEnv = process.env.KNOT_BUYER_KEYSTORE_PASSWORD
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const file = await readFile(ENV_FILE, "utf8").catch(() => "")
  const value = file.match(/^WALLET_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
  if (!value) {
    throw new Error("no keystore password: set KNOT_BUYER_KEYSTORE_PASSWORD or WALLET_PASSWORD")
  }
  return value
}

async function adminAccount() {
  const keystore = JSON.parse(await readFile(KEYSTORE, "utf8")) as Parameters<typeof decryptKeystore>[0]
  return privateKeyToAccount(decryptKeystore(keystore, await password()))
}

const publicClient = () => createPublicClient({ chain: bscTestnet, transport: http(RPC, { timeout: 30_000 }) })

async function readState(): Promise<SessionState> {
  return JSON.parse(await readFile(STATE, "utf8")) as SessionState
}

async function writeState(state: SessionState): Promise<void> {
  await mkdir(dirname(STATE), { recursive: true })
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`)
}

function newSession(): SessionState {
  const sessionPrivateKey = generatePrivateKey()
  const sessionAddress = privateKeyToAccount(sessionPrivateKey).address
  const publicKey = sessionPublicKeyFromAddress(sessionAddress)
  return {
    sessionAddress,
    sessionPrivateKey,
    keyHash: deriveKeyHash(SECP256K1_KEY_TYPE, publicKey),
    expiryUnix: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  }
}

function grantBatch(state: SessionState): Hex {
  const publicKey = sessionPublicKeyFromAddress(state.sessionAddress)
  return encodeErc7821Execute([
    buildAuthorizeCall(ACCOUNT, state.expiryUnix, publicKey),
    ...buildGrantCalls(ACCOUNT, state.keyHash, ALLOWED, TOKEN_LIMITS, NATIVE_CEILING, NATIVE_CEILING, DAY_PERIOD),
  ])
}

async function send(data: Hex): Promise<Hex> {
  const account = await adminAccount()
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(RPC, { timeout: 30_000 }) })
  const hash = await wallet.sendTransaction({ to: ACCOUNT, data, value: 0n })
  out(`  submitted ${hash}`)
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 180_000 })
  out(`  receipt ${receipt.status} in block ${receipt.blockNumber}`)
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`)
  return hash
}

async function readBack(state: SessionState): Promise<void> {
  const client = publicClient()
  const abi = [
    { type: "function", name: "canExecute", stateMutability: "view",
      inputs: [{ type: "bytes32" }, { type: "address" }, { type: "bytes" }], outputs: [{ type: "bool" }] },
  ] as const
  for (const entry of ALLOWED) {
    const can = await client.readContract({
      address: ACCOUNT, abi, functionName: "canExecute",
      args: [state.keyHash, entry.target, entry.selector],
    })
    out(`  ${entry.target} ${entry.selector} canExecute=${can}`)
    if (!can) throw new Error(`the account does not permit ${entry.selector} on ${entry.target}`)
  }
}

async function main(): Promise<void> {
  if (phase === "plan") {
    const state = newSession()
    out("\n  DRY RUN — nothing signed, nothing submitted\n")
    out(`  account       ${ACCOUNT}`)
    out(`  session addr  ${state.sessionAddress}`)
    out(`  key hash      ${state.keyHash}`)
    out(`  expiry        ${new Date(state.expiryUnix * 1000).toISOString()}`)
    out(`  token cap     ${BUDGET} on ${TOKEN} (period day)`)
    out(`  native cap    ${NATIVE_CEILING} wei (relay fee only)`)
    out(`  allowed calls ${ALLOWED.length}`)
    for (const entry of ALLOWED) out(`     ${entry.selector}  ${entry.target}`)
    out(`  grant batch   ${grantBatch(state).length / 2 - 1} bytes of calldata`)
    out("\n  next: run with `grant --execute` to submit\n")
    return
  }

  if (phase === "grant") {
    const state = newSession()
    const data = grantBatch(state)
    out(`\n  GRANT  session ${state.sessionAddress}  keyHash ${state.keyHash}`)
    if (!execute) {
      out("  dry run: pass --execute to submit\n")
      return
    }
    state.grantTransactionHash = await send(data)
    await writeState(state)
    out(`  state written to .secrets/session-hire-state.json\n`)
    return
  }

  if (phase === "verify") {
    const state = await readState()
    out(`\n  VERIFY  keyHash ${state.keyHash}`)
    await readBack(state)
    out("  every allowed call is permitted on chain\n")
    return
  }

  if (phase === "revoke") {
    const state = await readState()
    const data = encodeErc7821Execute(buildRevokeCalls(ACCOUNT, state.keyHash))
    out(`\n  REVOKE  keyHash ${state.keyHash}`)
    if (!execute) {
      out("  dry run: pass --execute to submit\n")
      return
    }
    state.revokeTransactionHash = await send(data)
    await writeState(state)
    out("  session revoked\n")
    return
  }

  throw new Error("usage: run-session-hire <plan|grant|verify|revoke> [--execute]")
}

await main().catch((error: unknown) => {
  out(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
