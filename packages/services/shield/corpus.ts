import { keccak256, stringToHex } from "viem"
import { z } from "zod"
import { shieldGroundTruthDataset, type ShieldGroundTruthDataset } from "./evaluate.ts"
import { shieldRuleId } from "./schemas.ts"

const severity = z.enum(["critical", "high", "medium", "low", "informational"])
const category = z.enum(["VULNERABILITY", "PRIVILEGED_CAPABILITY", "CONFIGURATION_RISK"])

export const shieldRules = z
  .object({
    schemaVersion: z.literal("knot.shield.rules/1"),
    policyVersion: z.string().min(1),
    frozenAtUtc: z.iso.datetime(),
    matchingDimensions: z.tuple([
      z.literal("ruleId"),
      z.literal("category"),
      z.literal("affectedAddress"),
      z.literal("sourceLocation"),
      z.literal("requiredPreconditions"),
    ]),
    rules: z.array(
      z
        .object({
          ruleId: shieldRuleId,
          category,
          severityPolicy: z.array(severity).min(1),
        })
        .strict(),
    ).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.rules.map((item) => item.ruleId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["rules"], message: "rule IDs must be unique" })
    }
    value.rules.forEach((rule, index) => {
      if (new Set(rule.severityPolicy).size !== rule.severityPolicy.length) {
        context.addIssue({ code: "custom", path: ["rules", index, "severityPolicy"], message: "severity values must be unique" })
      }
    })
  })

export type ShieldRules = z.infer<typeof shieldRules>

export type ShieldCorpusVerification = {
  datasetId: string
  fixtureCount: number
  developmentFixtureCount: number
  holdoutFixtureCount: number
  sourceFileCount: number
  rulesContentHash: `0x${string}`
  sourceBundleHashes: Record<string, `0x${string}`>
}

export class ShieldCorpusError extends Error {
  readonly code: "INVALID_RULES" | "RULES_MISMATCH" | "SOURCE_MISSING" | "SOURCE_HASH_MISMATCH" | "GROUND_TRUTH_MISMATCH"

  constructor(code: ShieldCorpusError["code"], message: string) {
    super(message)
    this.name = "ShieldCorpusError"
    this.code = code
  }
}

export function hashShieldSourceContent(content: string): `0x${string}` {
  return keccak256(stringToHex(content))
}

export function hashShieldSourceBundle(sourceFiles: readonly { path: string; contentHash: `0x${string}` }[]): `0x${string}` {
  return keccak256(stringToHex(JSON.stringify(sourceFiles)))
}

export function verifyShieldCorpus(
  datasetInput: unknown,
  rulesText: string,
  sourceContents: ReadonlyMap<string, string>,
): ShieldCorpusVerification {
  const dataset = parseDataset(datasetInput)
  const rules = parseRules(rulesText)
  const rulesContentHash = hashShieldSourceContent(rulesText)
  if (rulesContentHash !== dataset.rules.contentHash) {
    throw new ShieldCorpusError("RULES_MISMATCH", "rules content hash does not match ground truth")
  }
  if (rules.frozenAtUtc !== dataset.rulesFrozenAtUtc || rules.policyVersion !== dataset.adjudication.policyVersion) {
    throw new ShieldCorpusError("RULES_MISMATCH", "rules identity does not match ground truth")
  }

  const sourceBundleHashes: Record<string, `0x${string}`> = {}
  for (const fixture of dataset.fixtures) {
    validateLabels(fixture, rules)
    const actualFiles = fixture.sourceFiles.map((sourceFile) => {
      const content = sourceContents.get(sourceFile.path)
      if (content === undefined) throw new ShieldCorpusError("SOURCE_MISSING", `missing source ${sourceFile.path}`)
      const contentHash = hashShieldSourceContent(content)
      if (contentHash !== sourceFile.contentHash) {
        throw new ShieldCorpusError("SOURCE_HASH_MISMATCH", `source hash changed for ${sourceFile.path}`)
      }
      return { path: sourceFile.path, contentHash }
    })
    const bundleHash = hashShieldSourceBundle(actualFiles)
    if (bundleHash !== fixture.sourceBundleHash) {
      throw new ShieldCorpusError("SOURCE_HASH_MISMATCH", `source bundle hash changed for ${fixture.fixtureId}`)
    }
    sourceBundleHashes[fixture.fixtureId] = bundleHash
  }

  return {
    datasetId: dataset.datasetId,
    fixtureCount: dataset.fixtures.length,
    developmentFixtureCount: dataset.fixtures.filter((item) => item.role === "development").length,
    holdoutFixtureCount: dataset.fixtures.filter((item) => item.role === "holdout").length,
    sourceFileCount: new Set(dataset.fixtures.flatMap((item) => item.sourceFiles.map((source) => source.path))).size,
    rulesContentHash,
    sourceBundleHashes,
  }
}

function parseDataset(input: unknown): ShieldGroundTruthDataset {
  const parsed = shieldGroundTruthDataset.safeParse(input)
  if (!parsed.success) throw new ShieldCorpusError("GROUND_TRUTH_MISMATCH", "ground truth does not match the closed schema")
  return parsed.data
}

function parseRules(text: string): ShieldRules {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    throw new ShieldCorpusError("INVALID_RULES", "rules are not valid JSON")
  }
  const parsed = shieldRules.safeParse(input)
  if (!parsed.success) throw new ShieldCorpusError("INVALID_RULES", "rules do not match the closed schema")
  return parsed.data
}

function validateLabels(fixture: ShieldGroundTruthDataset["fixtures"][number], rules: ShieldRules): void {
  for (const finding of fixture.expectedFindings) {
    const rule = rules.rules.find((item) => item.ruleId === finding.ruleId)
    if (!rule || rule.category !== finding.category || finding.allowedSeverities.some((item) => !rule.severityPolicy.includes(item))) {
      throw new ShieldCorpusError("GROUND_TRUTH_MISMATCH", `finding label is outside frozen rules for ${fixture.fixtureId}`)
    }
  }
  for (const control of fixture.negativeControls) {
    const rule = rules.rules.find((item) => item.ruleId === control.ruleId)
    if (!rule || rule.category !== control.category) {
      throw new ShieldCorpusError("GROUND_TRUTH_MISMATCH", `negative control is outside frozen rules for ${fixture.fixtureId}`)
    }
  }
}
