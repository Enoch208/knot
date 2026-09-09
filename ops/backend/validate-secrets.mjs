import { readFileSync, statSync } from "node:fs"
import { isIP } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const schemaPath = new URL("secrets.schema.json", import.meta.url)
const schema = JSON.parse(readFileSync(schemaPath, "utf8"))

export function validateSecrets() {
  const values = new Map()
  for (const [file, rule] of Object.entries(schema.files)) {
    const mode = (statSync(file).mode & 0o777).toString(8).padStart(4, "0")
    if (mode !== rule.mode) throw new Error(`${file} mode is ${mode}, expected ${rule.mode}`)
    const allowedKeys = new Set([...rule.keys, ...(rule.optionalKeys ?? [])])
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      const split = line.indexOf("=")
      if (split < 1) throw new Error(`invalid line in ${file}`)
      const key = line.slice(0, split)
      const value = line.slice(split + 1)
      if (!allowedKeys.has(key)) throw new Error(`unexpected key ${key} in ${file}`)
      if (values.has(key)) throw new Error(`duplicate key ${key}`)
      if (!value) throw new Error(`${key} is empty`)
      values.set(key, value)
    }
    for (const key of rule.keys) {
      if (!values.has(key)) throw new Error(`${file} lacks ${key}`)
    }
  }
  validateSecretValues(values)
}

export function validateSecretValues(values) {
  const required = (key) => {
    const value = values.get(key)
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  const database = new URL(required("DATABASE_URL"))
  const allowedOrigin = new URL(required("KNOT_API_ALLOWED_ORIGIN"))

  if (!new Set(["postgres:", "postgresql:"]).has(database.protocol)) throw new Error("invalid database protocol")
  if (database.hostname !== schema.constraints.DATABASE_URL_HOST) throw new Error("invalid database host")
  if (decodeURIComponent(database.username) !== required("POSTGRES_USER")) throw new Error("database user mismatch")
  if (decodeURIComponent(database.password) !== required("POSTGRES_PASSWORD")) throw new Error("database password mismatch")
  if (decodeURIComponent(database.pathname.slice(1)) !== required("POSTGRES_DB")) throw new Error("database name mismatch")
  if (required("ARTIFACT_STORE_ENDPOINT") !== schema.constraints.ARTIFACT_STORE_ENDPOINT) throw new Error("invalid artifact endpoint")
  if (required("ARTIFACT_STORE_BUCKET") !== schema.constraints.ARTIFACT_STORE_BUCKET) throw new Error("invalid artifact bucket")
  if (required("AWS_ACCESS_KEY_ID") === required("MINIO_ROOT_USER")) throw new Error("artifact client must not use the root account")
  if (required("AWS_SECRET_ACCESS_KEY") === required("MINIO_ROOT_PASSWORD")) throw new Error("artifact client must not use the root secret")
  if (required("AWS_ACCESS_KEY_ID").length < 3) throw new Error("artifact access key is too short")
  if (required("AWS_SECRET_ACCESS_KEY").length < 16) throw new Error("artifact secret key is too short")
  if (required("MINIO_ROOT_PASSWORD").length < 16) throw new Error("artifact root secret is too short")
  if (required("KNOT_API_AUTH_TOKEN").length < 32) throw new Error("API auth token is too short")
  if (!/^0x[0-9a-fA-F]{40}$/.test(required("KNOT_API_BUYER_ADDRESS"))) throw new Error("invalid API buyer address")
  if (allowedOrigin.origin !== required("KNOT_API_ALLOWED_ORIGIN")) throw new Error("allowed origin must be an origin")
  if (allowedOrigin.protocol !== "https:") throw new Error("allowed origin must use HTTPS")

  const ownedSellerEnabled = required("KNOT_OWNED_SELLER_NEGOTIATION_ENABLED")
  if (!new Set(["true", "false"]).has(ownedSellerEnabled)) throw new Error("invalid owned seller negotiation flag")
  if (ownedSellerEnabled === "true") {
    const credentials = [
      ["KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_ID", "KNOT_OWNED_SELLER_HEALTHGUARD_CLIENT_SECRET"],
      ["KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_ID", "KNOT_OWNED_SELLER_RANGEPILOT_CLIENT_SECRET"],
      ["KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_ID", "KNOT_OWNED_SELLER_GRIDQUANT_CLIENT_SECRET"],
      ["KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_ID", "KNOT_OWNED_SELLER_YIELDSCOUT_CLIENT_SECRET"],
    ]
    const secrets = credentials.map(([clientIdKey, clientSecretKey]) => {
      boundedPrintable(required(clientIdKey), 1, 256, clientIdKey)
      return boundedPrintable(required(clientSecretKey), 16, 4_096, clientSecretKey)
    })
    if (new Set(secrets).size !== secrets.length) throw new Error("owned seller client secrets must be distinct")
    if (secrets.includes(required("KNOT_API_AUTH_TOKEN"))) throw new Error("owned seller client secrets must differ from the API auth token")
  }

  if (!new Set(["true", "false"]).has(required("KNOT_CHAIN_RECOVERY_ENABLED"))) throw new Error("invalid chain recovery flag")
  validatePublicRpcUrl(required("KNOT_BSC_MAINNET_RPC_URL"), "mainnet RPC URL")
  validatePublicRpcUrl(required("KNOT_BSC_TESTNET_RPC_URL"), "testnet RPC URL")
  boundedInteger(required("KNOT_CHAIN_56_CONFIRMATIONS"), 15, 100, "mainnet confirmations")
  boundedInteger(required("KNOT_CHAIN_97_CONFIRMATIONS"), 2, 100, "testnet confirmations")
  const timeout = boundedInteger(required("KNOT_CHAIN_OBSERVATION_TIMEOUT_MILLISECONDS"), 100, 60_000, "chain observation timeout")
  const lease = boundedInteger(required("KNOT_CHAIN_RECOVERY_LEASE_MILLISECONDS"), 3_000, 300_000, "chain recovery lease")
  if (lease <= timeout + 2_000) throw new Error("chain recovery lease must exceed timeout by more than 2000 milliseconds")
  boundedInteger(required("KNOT_CHAIN_RECOVERY_SCAN_LIMIT"), 1, 4, "chain recovery scan limit")
}

function boundedPrintable(input, minimum, maximum, label) {
  if (input.length < minimum || input.length > maximum || !/^[\x20-\x7e]+$/.test(input)) {
    throw new Error(`${label} is invalid`)
  }
  return input
}

function validatePublicRpcUrl(input, label) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`)
  if (url.username !== "" || url.password !== "") throw new Error(`${label} cannot contain credentials`)
  if (url.search !== "" || url.hash !== "") throw new Error(`${label} cannot contain a query or fragment`)
  if (url.port !== "" && url.port !== "443") throw new Error(`${label} must use port 443`)
  const hostname = normalizeHostname(url.hostname)
  if (!isPublicHostname(hostname)) throw new Error(`${label} must use a public hostname`)
}

function boundedInteger(input, minimum, maximum, label) {
  if (!/^(0|[1-9]\d*)$/.test(input)) throw new Error(`${label} must be an integer`)
  const value = Number(input)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its supported range`)
  return value
}

function normalizeHostname(hostname) {
  const value = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  return value.toLowerCase().replace(/\.$/, "")
}

function isPublicHostname(hostname) {
  const family = isIP(hostname)
  if (family === 4) return isPublicIpv4(hostname)
  if (family === 6) return isPublicIpv6(hostname)
  if (!hostname.includes(".")) return false
  return ![".localhost", ".local", ".internal", ".home.arpa", ".onion"].some((suffix) => hostname.endsWith(suffix))
}

function isPublicIpv4(address) {
  const octets = address.split(".").map(Number)
  const first = octets[0] ?? -1
  const second = octets[1] ?? -1
  const third = octets[2] ?? -1
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168)) return false
  if (first === 192 && second === 88 && third === 99) return false
  if (first === 198 && (second === 18 || second === 19)) return false
  if (first === 198 && second === 51 && third === 100) return false
  if (first === 203 && second === 0 && third === 113) return false
  return !(first === 192 && second === 0 && third === 2)
}

function isPublicIpv6(address) {
  if (address.includes(".")) return false
  const hextets = expandIpv6(address)
  if (!hextets) return false
  const first = hextets[0] ?? 0
  const second = hextets[1] ?? 0
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false
  if (first === 0x3fff && (second & 0xf000) === 0) return false
  return first !== 0x2002 && first !== 0x3ffe
}

function expandIpv6(address) {
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return null
  const left = halves[0] === "" ? [] : halves[0].split(":")
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":")
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((value) => Number.parseInt(value, 16))
  return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff) ? values : null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validateSecrets()
