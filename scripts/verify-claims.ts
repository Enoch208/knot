import { resolve } from "node:path"
import { readAndVerifyClaimLedger } from "../packages/evidence/src/index.ts"

const repositoryRoot = resolve(import.meta.dirname, "..")
const ledger = readAndVerifyClaimLedger(resolve(repositoryRoot, "evidence/claims.json"), repositoryRoot)
process.stdout.write(`[claims] verified ${ledger.claims.length} structurally valid claim record(s) and their local evidence bindings; this does not prove claim truth or live availability\n`)
