import { readFileSync, statSync } from "node:fs"

const schemaPath = new URL("secrets.schema.json", import.meta.url)
const schema = JSON.parse(readFileSync(schemaPath, "utf8"))
const values = new Map()

for (const [file, rule] of Object.entries(schema.files)) {
  const mode = (statSync(file).mode & 0o777).toString(8).padStart(4, "0")
  if (mode !== rule.mode) throw new Error(`${file} mode is ${mode}, expected ${rule.mode}`)
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
    const split = line.indexOf("=")
    if (split < 1) throw new Error(`invalid line in ${file}`)
    const key = line.slice(0, split)
    const value = line.slice(split + 1)
    if (values.has(key)) throw new Error(`duplicate key ${key}`)
    if (!value) throw new Error(`${key} is empty`)
    values.set(key, value)
  }
  for (const key of rule.keys) {
    if (!values.has(key)) throw new Error(`${file} lacks ${key}`)
  }
}

const required = (key) => values.get(key)
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
