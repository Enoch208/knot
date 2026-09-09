import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

interface SecretValidatorModule {
  validateSecretValues(values: ReadonlyMap<string, string>): void
}

const validatorPath = resolve(import.meta.dirname, "../../ops/backend/validate-secrets.mjs")
const { validateSecretValues } = await import(pathToFileURL(validatorPath).href) as SecretValidatorModule

const chainKeys = [
  "KNOT_CHAIN_RECOVERY_ENABLED",
  "KNOT_BSC_MAINNET_RPC_URL",
  "KNOT_BSC_TESTNET_RPC_URL",
  "KNOT_CHAIN_56_CONFIRMATIONS",
  "KNOT_CHAIN_97_CONFIRMATIONS",
  "KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS",
  "KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS",
  "KNOT_CHAIN_RECOVERY_SCAN_LIMIT",
]

const ownedSellerOptionalKeys = [
  "KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID",
  "KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET",
  "KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID",
  "KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET",
  "KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_ID",
  "KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET",
  "KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_ID",
  "KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET",
]

function validValues(changes: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    DATABASE_URL: "postgresql://knot-client:database-secret@postgres/knot",
    POSTGRES_DB: "knot",
    POSTGRES_USER: "knot-client",
    POSTGRES_PASSWORD: "database-secret",
    ARTIFACT_STORE_ENDPOINT: "http://object-store:9000",
    ARTIFACT_STORE_BUCKET: "knot-artifacts",
    AWS_ACCESS_KEY_ID: "artifact-client",
    AWS_SECRET_ACCESS_KEY: "artifact-client-secret-value",
    MINIO_ROOT_USER: "root-account",
    MINIO_ROOT_PASSWORD: "object-store-root-secret",
    KNOT_API_AUTH_TOKEN: "a".repeat(32),
    KNOT_API_BUYER_ADDRESS: `0x${"b".repeat(40)}`,
    KNOT_API_ALLOWED_ORIGIN: "https://knot.example",
    KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: "true",
    KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID: "health-client",
    KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET: "health-secret-0001",
    KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID: "range-client",
    KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET: "range-secret-00001",
    KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_ID: "grid-client",
    KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET: "grid-secret-000001",
    KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_ID: "yield-client",
    KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET: "yield-secret-00001",
    KNOT_CHAIN_RECOVERY_ENABLED: "true",
    KNOT_BSC_MAINNET_RPC_URL: "https://bsc-rpc.publicnode.com",
    KNOT_BSC_TESTNET_RPC_URL: "https://bsc-testnet-rpc.publicnode.com",
    KNOT_CHAIN_56_CONFIRMATIONS: "15",
    KNOT_CHAIN_97_CONFIRMATIONS: "2",
    KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "10000",
    KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS: "30000",
    KNOT_CHAIN_RECOVERY_SCAN_LIMIT: "2",
    ...changes,
  }))
}

function disabledOwnedSellerValues(): Map<string, string> {
  const values = validValues({ KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: "false" })
  for (const key of ownedSellerOptionalKeys) values.delete(key)
  return values
}

test("deployment schema binds a mode-0600 chain observer environment only to the worker", async () => {
  const schema = JSON.parse(await readFile("ops/backend/secrets.schema.json", "utf8")) as {
    files: Record<string, { mode: string; keys: string[] }>
  }
  assert.deepEqual(schema.files["/etc/knot/chain-read.env"], { mode: "0600", keys: chainKeys })
  const compose = await readFile("ops/backend/compose.yaml", "utf8")
  assert.equal(compose.match(/\/etc\/knot\/chain-read\.env/g)?.length, 1)
  const workerStart = compose.indexOf("\n  worker:")
  const artifactToolsStart = compose.indexOf("\n  artifact-tools:")
  assert.ok(workerStart >= 0)
  assert.ok(artifactToolsStart > workerStart)
  assert.match(compose.slice(workerStart, artifactToolsStart), /- \/etc\/knot\/chain-read\.env/)
})

test("deployment validation accepts the bounded read-only observer configuration", () => {
  assert.doesNotThrow(() => validateSecretValues(validValues()))
  assert.doesNotThrow(() => validateSecretValues(validValues({ KNOT_CHAIN_RECOVERY_ENABLED: "false" })))
})

test("deployment schema isolates owned seller credentials to the API", async () => {
  const schema = JSON.parse(await readFile("ops/backend/secrets.schema.json", "utf8")) as {
    files: Record<string, { mode: string; keys: string[]; optionalKeys?: string[] }>
  }
  assert.deepEqual(schema.files["/etc/knot/owned-sellers.env"], {
    mode: "0600",
    keys: ["KNOT_OWNED_SELLER_NEGOTIATION_ENABLED"],
    optionalKeys: ownedSellerOptionalKeys,
  })
  const compose = await readFile("ops/backend/compose.yaml", "utf8")
  assert.equal(compose.match(/\/etc\/knot\/owned-sellers\.env/g)?.length, 1)
  const apiStart = compose.indexOf("\n  api:")
  const workerStart = compose.indexOf("\n  worker:")
  assert.ok(apiStart >= 0)
  assert.ok(workerStart > apiStart)
  assert.match(compose.slice(apiStart, workerStart), /- \/etc\/knot\/owned-sellers\.env/)
})

test("deployment validation permits explicit disable without credential material", () => {
  assert.doesNotThrow(() => validateSecretValues(disabledOwnedSellerValues()))
})

test("deployment validation rejects incomplete or unsafe owned seller credentials", () => {
  const missing = validValues()
  missing.delete("KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET")
  assert.throws(() => validateSecretValues(missing))
  const cases: Array<Record<string, string>> = [
    { KNOT_OWNED_SELLER_NEGOTIATION_ENABLED: "TRUE" },
    { KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID: "health\nclient" },
    { KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET: "short" },
    { KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET: "x".repeat(4_097) },
    { KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET: "yield-secret-000\u007f" },
    {
      KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET: "health-secret-0001",
      KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET: "health-secret-0001",
    },
    {
      KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET: "a".repeat(32),
      KNOT_API_AUTH_TOKEN: "a".repeat(32),
    },
  ]
  for (const changes of cases) assert.throws(() => validateSecretValues(validValues(changes)))
})

test("deployment validation rejects unsafe chain observer values", () => {
  const cases: Array<Record<string, string>> = [
    { KNOT_CHAIN_RECOVERY_ENABLED: "TRUE" },
    { KNOT_BSC_MAINNET_RPC_URL: "http://bsc.example/rpc" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://user:secret@bsc.example/rpc" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://bsc.example/rpc?key=secret" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://bsc.example/rpc#fragment" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://bsc.example:8443/rpc" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://localhost/rpc" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://rpc.internal/rpc" },
    { KNOT_BSC_MAINNET_RPC_URL: "https://127.0.0.1/rpc" },
    { KNOT_BSC_TESTNET_RPC_URL: "https://10.0.0.1/rpc" },
    { KNOT_BSC_TESTNET_RPC_URL: "https://[::1]/rpc" },
    { KNOT_CHAIN_56_CONFIRMATIONS: "14" },
    { KNOT_CHAIN_97_CONFIRMATIONS: "1" },
    { KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "99" },
    { KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "60001" },
    { KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS: "12000", KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS: "10000" },
    { KNOT_CHAIN_RECOVERY_SCAN_LIMIT: "0" },
    { KNOT_CHAIN_RECOVERY_SCAN_LIMIT: "5" },
  ]
  for (const changes of cases) assert.throws(() => validateSecretValues(validValues(changes)))
})
