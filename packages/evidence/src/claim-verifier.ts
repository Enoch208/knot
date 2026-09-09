import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, posix, relative, resolve, sep } from "node:path"
import { keccak256, toHex } from "viem"
import { claimLedger, type ClaimLedger, type ClaimSource } from "./claim-schema.ts"

export class ClaimLedgerValidationError extends Error {
  readonly code: "SCHEMA_INVALID" | "PATH_INVALID" | "PATH_MISSING" | "HASH_MISMATCH" | "COMMAND_NOT_ALLOWED"

  constructor(code: ClaimLedgerValidationError["code"], message: string) {
    super(message)
    this.name = "ClaimLedgerValidationError"
    this.code = code
  }
}

const repositoryTestCommands = new Set([
  "npm run test:root",
  "npm run test:healthguard",
  "npm run test:advantage",
  "npm run test:parity",
  "npm run test:sellers",
  "npm run category:parity",
])
const repositoryCommandBindings = new Map([
  ["npm run chain-recovery-rollout:verify", "scripts/verify-chain-recovery-rollout.ts"],
  ["npm run claims:verify", "scripts/verify-claims.ts"],
  ["npm run external-paid-job:verify", "scripts/verify-external-paid-job.ts"],
  ["npm run external-paid-job:verify -- evidence/testnet/external-paid-job-1198.json", "scripts/verify-external-paid-job.ts"],
  ["npm run external-paid-job:verify -- evidence/testnet/external-paid-job-1203.json", "scripts/verify-external-paid-job.ts"],
  ["npm run external-paid-job:verify:live", "scripts/verify-external-paid-job-live.ts"],
  ["npm run external-paid-job:verify:live -- evidence/testnet/external-paid-job-1198.json", "scripts/verify-external-paid-job-live.ts"],
  ["npm run external-paid-job:verify:live -- evidence/testnet/external-paid-job-1203.json", "scripts/verify-external-paid-job-live.ts"],
  ["npm run manifest:verify", "scripts/verify-manifest.ts"],
  ["npm run sellers:verify:public", "scripts/verify-public-sellers.ts"],
  ["npm run shield:verify", "scripts/verify-shield-measurement.ts"],
  ["npm run tunnel:verify -- evidence/operations/tunnel-recovery-20260909.json", "scripts/verify-tunnel-recovery.ts"],
])

export function verifyClaimLedger(candidate: unknown, repositoryRoot: string): ClaimLedger {
  const parsed = claimLedger.safeParse(candidate)
  if (!parsed.success) throw new ClaimLedgerValidationError("SCHEMA_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  const root = realpathSync(repositoryRoot)
  for (const claim of parsed.data.claims) {
    for (const source of claim.sources) verifySource(source, root)
  }
  return parsed.data
}

export function readAndVerifyClaimLedger(ledgerPath: string, repositoryRoot: string): ClaimLedger {
  let candidate: unknown
  try {
    candidate = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown
  } catch (error) {
    throw new ClaimLedgerValidationError("SCHEMA_INVALID", error instanceof Error ? error.message : "claim ledger is not readable JSON")
  }
  return verifyClaimLedger(candidate, repositoryRoot)
}

function verifySource(source: ClaimSource, root: string): void {
  if ("path" in source) {
    const path = resolveEvidencePath(root, source.path)
    if ("contentHash" in source) {
      const observed = keccak256(toHex(readFileSync(path)))
      if (observed !== source.contentHash) throw new ClaimLedgerValidationError("HASH_MISMATCH", `${source.path} does not match declared contentHash`)
    }
  }
  if ("command" in source) verifyDocumentaryCommand(source)
}

function resolveEvidencePath(root: string, value: string): string {
  if (isAbsolute(value) || value.includes("\\") || posix.normalize(value) !== value || value === "." || value.startsWith("../")) {
    throw new ClaimLedgerValidationError("PATH_INVALID", `repository evidence path is not a normalized relative path: ${value}`)
  }
  const lexical = resolve(root, value)
  if (!inside(root, lexical)) throw new ClaimLedgerValidationError("PATH_INVALID", `repository evidence path escapes the repository: ${value}`)
  let actual: string
  try {
    actual = realpathSync(lexical)
  } catch {
    throw new ClaimLedgerValidationError("PATH_MISSING", `repository evidence path does not exist: ${value}`)
  }
  if (!inside(root, actual)) throw new ClaimLedgerValidationError("PATH_INVALID", `repository evidence path resolves outside the repository: ${value}`)
  if (!statSync(actual).isFile()) throw new ClaimLedgerValidationError("PATH_INVALID", `repository evidence path is not a file: ${value}`)
  return actual
}

function verifyDocumentaryCommand(source: Extract<ClaimSource, { command: string }>): void {
  const command = source.command
  if (source.type === "paired_experiment_dataset") {
    if (command !== `npm run advantage:verify -- ${source.path}`) rejectCommand(command)
    return
  }
  if (source.type === "repository_command") {
    if (repositoryCommandBindings.get(command) !== source.path) rejectCommand(command)
    return
  }
  if (repositoryTestCommands.has(command) || command === `node --test ${source.path}`) return
  rejectCommand(command)
}

function rejectCommand(command: string): never {
  throw new ClaimLedgerValidationError("COMMAND_NOT_ALLOWED", `claim command is documentary but not allowlisted: ${command}`)
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}
