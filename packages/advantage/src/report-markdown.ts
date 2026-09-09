import { posix } from "node:path"
import type { PairedExperimentRecord } from "./schemas.ts"
import type { VerifiedReportExperiment, VerifiedShieldReport } from "./report.ts"

const names = {
  health: "HealthGuard",
  rebalancing: "RangePilot",
  grid: "GridQuant",
  yield: "YieldScout",
} as const

export function renderAgentAdvantageReport(
  experiments: readonly VerifiedReportExperiment[],
  shield: VerifiedShieldReport,
): string {
  const lines = [
    "# Agent Advantage Report",
    "",
    "This report is generated from SHA-256-bound evidence. The generator re-runs each category's independent evaluator before rendering any result. Run `npm run advantage:report` to validate all sources and reproduce this file.",
    "",
    "## Paired marketplace experiments",
    "",
    "Each paid agent used BSC mainnet read-only input and BSC testnet identity, payment, and settlement. Every baseline used the identical frozen task input without consuming the agent output. `same_operator_reference` means KNOT operates the seller and reference implementation; evaluator independence here means the score is recomputed from raw bytes, not that the businesses are independent.",
    "",
    "| Service | Experiment | Quality | Operator relationship |",
    "| --- | --- | --- | --- |",
    ...experiments.map(summaryRow),
    "",
  ]
  for (const experiment of experiments) lines.push(...experimentSection(experiment))
  lines.push(...shieldSection(shield))
  lines.push(
    "## Interpretation limits",
    "",
    "- All four finance results are single-input quality observations. A tie is a tie; none establishes superiority or repeatability.",
    "- Three TaskSpecs cryptographically match their committed raw input bytes. HealthGuard's paired paths share the same separately SHA-256-bound input, but its TaskSpec input hash does not match the committed input bytes; the authentic signed-task preimage binding is therefore not established.",
    "- Agent lifecycle durations and baseline calculation measurements have different boundaries. They do not establish a speed, latency, labor, or human-time advantage.",
    "- Service fees are testnet U and network fees are tBNB. They are not revenue, dollars, or evidence of production cost advantage.",
    "- No paired result establishes profit, APY, return, savings, PnL, win rate, execution quality, or future performance.",
    "- The finance artifacts are analysis only. No mainnet position, order, swap, deposit, withdrawal, migration, or repayment was executed.",
    "- Shield is a separate team-owned synthetic-corpus measurement, not a paired marketplace experiment or evidence of comprehensive audit quality.",
    "",
  )
  return lines.join("\n")
}

function summaryRow(source: VerifiedReportExperiment): string {
  const record = source.record
  const quality = `${record.comparison.winner}; ${record.comparison.agentWins} agent / ${record.comparison.baselineWins} baseline / ${record.comparison.ties} tied dimensions`
  return `| ${names[source.category]} | [${record.experimentId}](${fromDocs(source.repositoryPath)}) | ${quality} | \`${record.agentPath.operatorRelationship}\` |`
}

function experimentSection(source: VerifiedReportExperiment): string[] {
  const record = source.record
  const baselineClasses = [...new Set([
    record.baselinePath.implementation.evidenceClass,
    record.baselinePath.rawOutput.evidenceClass,
    record.baselinePath.artifact.evidenceClass,
  ])].join(", ")
  const baselineScope = baselineClasses.includes("historical_replay")
    ? "computed later as a historical replay over frozen bytes; calculation-only and not timing-comparable to the paid lifecycle"
    : "direct calculation over the identical prepared mainnet observation; calculation-only and excludes commerce, network, and human overhead"
  return [
    `### ${names[source.category]} — \`${source.category}\``,
    "",
    `- Quality: **${record.comparison.winner}** — ${record.comparison.agentWins} agent wins, ${record.comparison.baselineWins} baseline wins, ${record.comparison.ties} ties; decisive dimension: ${record.comparison.decisiveDimensionId === null ? "none" : `\`${record.comparison.decisiveDimensionId}\``}.`,
    `- Operator relationship: \`${record.agentPath.operatorRelationship}\`.`,
    `- Task-to-input binding: ${inputBinding(source)}.`,
    `- Agent lifecycle boundary: \`${record.agentPath.observation.startedAtUtc}\` → \`${record.agentPath.observation.endedAtUtc}\` (${record.agentPath.observation.durationMs.toLocaleString("en-US")} ms), from recorded marketplace start through confirmed submission.`,
    `- Agent costs: ${record.agentPath.costs.map(formatCost).join("; ")}.`,
    `- Baseline: \`${record.baselinePath.methodId}@${record.baselinePath.methodVersion}\`; evidence class ${baselineClasses}; observation ${record.baselinePath.observation.durationMs.toLocaleString("en-US")} ms; ${record.baselinePath.costs.map(formatCost).join("; ")}; ${baselineScope}.`,
    `- Raw evidence: ${evidenceLinks(source)}.`,
    "",
    "| Quality dimension | Agent score (bps) | Baseline score (bps) | Result |",
    "| --- | ---: | ---: | --- |",
    ...record.evaluation.dimensions.map((dimension) => `| ${dimension.label} (\`${dimension.id}\`) | ${dimension.agent.scoreBps} | ${dimension.baseline.scoreBps} | ${dimension.result} |`),
    "",
  ]
}

function shieldSection(shield: VerifiedShieldReport): string[] {
  const evaluation = shield.evaluation
  const report = shield.report
  const holdout = report.fixtures.filter((fixture) => fixture.role === "holdout")
  const holdoutCounts = holdout.reduce(
    (counts, fixture) => ({
      truePositives: counts.truePositives + fixture.counts.truePositives,
      falsePositives: counts.falsePositives + fixture.counts.falsePositives,
      falseNegatives: counts.falseNegatives + fixture.counts.falseNegatives,
    }),
    { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
  )
  const preserved = evaluation.preservedEvidence
  const links = [
    markdownLink("evaluation", shield.evaluationPath),
    markdownLink("capture", preserved.capturePath),
    markdownLink("manual validation", preserved.manualValidationPath),
    markdownLink("runs", preserved.runsPath),
    markdownLink("ground truth", preserved.groundTruthPath),
    ...shield.capture.outputs.map((output) => markdownLink(`raw ${output.fixtureId}`, output.path)),
  ]
  return [
    "## Shield high-stakes corpus evaluation",
    "",
    "Shield is reported separately because it is a measured specialist evaluation, not one of the four paired marketplace experiments.",
    "",
    `- Dataset: \`${evaluation.datasetId}\`; ${report.completedFixtureCount} completed fixtures, including ${report.holdoutFixtureCount} holdout.`,
    `- Relationship: ${evaluation.relationship}`,
    `- Toolchain: ${evaluation.tooling.analyzer.name} ${evaluation.tooling.analyzer.version}, ${evaluation.tooling.analyzer.detectorCount} detectors; ${evaluation.tooling.compiler.name} ${evaluation.tooling.compiler.version}.`,
    `- Adjudicated result: ${report.counts.truePositives} true positives, ${report.counts.falsePositives} false positives, ${report.counts.falseNegatives} false negatives; precision ${fraction(report.precision)}, recall ${fraction(report.recall)}, severity validity ${fraction(report.severityValidity)}.`,
    `- Holdout result: ${holdoutCounts.truePositives} true positives, ${holdoutCounts.falsePositives} false positives, ${holdoutCounts.falseNegatives} false negatives.`,
    `- Raw signals: ${evaluation.rawSignalCounts.total} total, ${evaluation.rawSignalCounts.confirmed} confirmed, ${evaluation.rawSignalCounts.rejected} rejected after manual validation, ${evaluation.rawSignalCounts.outOfScope} outside the frozen Shield rules.`,
    `- Evidence: ${links.join(" · ")}.`,
    "- Limits:",
    ...[...evaluation.limitations, ...report.limitations].map((limitation) => `  - ${limitation}.`),
    "",
  ]
}

function evidenceLinks(source: VerifiedReportExperiment): string {
  const record = source.record
  const directory = posix.dirname(source.repositoryPath)
  const references = [
    ["dataset", source.repositoryPath],
    ["task", posix.join(directory, record.task.reference.uri)],
    ["input", posix.join(directory, record.input.uri)],
    ["agent raw", posix.join(directory, record.agentPath.rawOutput.uri)],
    ["agent artifact", posix.join(directory, record.agentPath.artifact.uri)],
    ["baseline method", posix.join(directory, record.baselinePath.implementation.uri)],
    ["baseline raw", posix.join(directory, record.baselinePath.rawOutput.uri)],
    ["baseline artifact", posix.join(directory, record.baselinePath.artifact.uri)],
    ...record.agentPath.costs.map((cost) => [`${cost.kind} evidence`, posix.join(directory, cost.provenance.uri)]),
    ...record.baselinePath.costs.map((cost) => [`${cost.kind} evidence`, posix.join(directory, cost.provenance.uri)]),
    ...source.lifecycleEvidencePaths.map((path, index) => [`${index === 0 ? "lifecycle" : "terminal"} proof`, path]),
  ] as const
  return references.map(([label, path]) => markdownLink(label, path)).join(" · ")
}

function formatCost(cost: PairedExperimentRecord["agentPath"]["costs"][number]): string {
  const amount = cost.amount
  const chain = amount.chainId === null ? "" : `, chain ${amount.chainId}`
  if (amount.decimals === 0 && amount.chainId === null) return `${cost.kind} ${amount.units} ${amount.symbol}`
  return `${cost.kind} ${decimalUnits(amount.units, amount.decimals)} ${amount.symbol} (${amount.units} base units${chain})`
}

function inputBinding(source: VerifiedReportExperiment): string {
  if (source.inputBinding.exact) {
    return `exact — TaskSpec \`inputHash\` equals raw-input Keccak-256 \`${source.inputBinding.rawInputKeccak256}\``
  }
  return `partial — both paths share the same SHA-256-bound input, but TaskSpec \`inputHash\` \`${source.inputBinding.taskInputHash}\` does not equal raw-input Keccak-256 \`${source.inputBinding.rawInputKeccak256}\`; no authentic preimage is claimed`
}

function decimalUnits(units: string, decimals: number): string {
  if (decimals === 0) return units
  const padded = units.padStart(decimals + 1, "0")
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, "")
  return fraction.length === 0 ? whole : `${whole}.${fraction}`
}

function fraction(value: { numerator: number; denominator: number; decimal: string | null }): string {
  return value.decimal === null
    ? `${value.numerator}/${value.denominator}`
    : `${value.numerator}/${value.denominator} (${value.decimal})`
}

function markdownLink(label: string, repositoryPath: string): string {
  return `[${label}](${fromDocs(repositoryPath)})`
}

function fromDocs(repositoryPath: string): string {
  return `../${repositoryPath}`
}
