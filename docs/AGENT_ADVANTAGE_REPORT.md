# Agent Advantage Report

This report is generated from SHA-256-bound evidence. The generator re-runs each category's independent evaluator before rendering any result. Run `npm run advantage:report` to validate all sources and reproduce this file.

## Paired marketplace experiments

Each paid agent used BSC mainnet read-only input and BSC testnet identity, payment, and settlement. Every baseline used the identical frozen task input without consuming the agent output. `same_operator_reference` means KNOT operates the seller and reference implementation; evaluator independence here means the score is recomputed from raw bytes, not that the businesses are independent.

| Service | Experiment | Quality | Operator relationship |
| --- | --- | --- | --- |
| HealthGuard | [healthguard-1185](../evidence/advantage/healthguard-1185/dataset.json) | tie; 0 agent / 0 baseline / 4 tied dimensions | `same_operator_reference` |
| RangePilot | [rangepilot-1189](../evidence/advantage/rangepilot-1189/dataset.json) | tie; 0 agent / 0 baseline / 6 tied dimensions | `same_operator_reference` |
| GridQuant | [gridquant-1187](../evidence/advantage/gridquant-1187/dataset.json) | tie; 0 agent / 0 baseline / 5 tied dimensions | `same_operator_reference` |
| YieldScout | [yieldscout-1188](../evidence/advantage/yieldscout-1188/dataset.json) | tie; 0 agent / 0 baseline / 5 tied dimensions | `same_operator_reference` |

### HealthGuard — `health`

- Quality: **tie** — 0 agent wins, 0 baseline wins, 4 ties; decisive dimension: none.
- Operator relationship: `same_operator_reference`.
- Task-to-input binding: partial — both paths share the same SHA-256-bound input, but TaskSpec `inputHash` `0xd13d4ebcbdf270ab724ca782214c900c79451528aab8aaf3e0b657e7cfd29c49` does not equal raw-input Keccak-256 `0xe0bcb1f88b24f805ebb73530b9c849a8074aef6be9f7f8f2efcbafc4d526fdd3`; no authentic preimage is claimed.
- Agent lifecycle boundary: `2026-09-09T10:31:35.395Z` → `2026-09-09T10:32:19.000Z` (43,605 ms), from recorded marketplace start through confirmed submission.
- Agent costs: service_fee 0.1 U (100000000000000000 base units, chain 97); network_fee 0.002555089 tBNB (2555089000000000 base units, chain 97).
- Baseline: `direct-venus-pinned-integer-math@1.0.0`; evidence class mainnet_observation; observation 1 ms; compute 1 ms; direct calculation over the identical prepared mainnet observation; calculation-only and excludes commerce, network, and human overhead.
- Raw evidence: [dataset](../evidence/advantage/healthguard-1185/dataset.json) · [task](../evidence/advantage/healthguard-1185/task.json) · [input](../evidence/advantage/healthguard-1185/input.json) · [agent raw](../evidence/advantage/healthguard-1185/agent-manifest.json) · [agent artifact](../evidence/advantage/healthguard-1185/agent-artifact.json) · [baseline method](../evidence/advantage/healthguard-1185/baseline-method.json) · [baseline raw](../evidence/advantage/healthguard-1185/baseline-observation.json) · [baseline artifact](../evidence/advantage/healthguard-1185/baseline-artifact.json) · [service_fee evidence](../evidence/advantage/healthguard-1185/agent-service-cost.json) · [network_fee evidence](../evidence/advantage/healthguard-1185/agent-network-cost.json) · [compute evidence](../evidence/advantage/healthguard-1185/baseline-compute-cost.json) · [lifecycle proof](../evidence/advantage/healthguard-1185/job-1185.json).

| Quality dimension | Agent score (bps) | Baseline score (bps) | Result |
| --- | ---: | ---: | --- |
| Closed artifact and input identity (`contract_integrity`) | 10000 | 10000 | tie |
| Risk-state classification (`risk_classification`) | 10000 | 10000 | tie |
| Collateral, debt, threshold, and health math (`deterministic_math`) | 10000 | 10000 | tie |
| Recommendation and bounded repayment (`bounded_recommendation`) | 10000 | 10000 | tie |

### RangePilot — `rebalancing`

- Quality: **tie** — 0 agent wins, 0 baseline wins, 6 ties; decisive dimension: none.
- Operator relationship: `same_operator_reference`.
- Task-to-input binding: exact — TaskSpec `inputHash` equals raw-input Keccak-256 `0x0c074f3a144d94bd672822f603f735abaea245ef54b0ad5b2ac405ca0a00c8c2`.
- Agent lifecycle boundary: `2026-09-09T11:15:24.600Z` → `2026-09-09T11:18:48.000Z` (203,400 ms), from recorded marketplace start through confirmed submission.
- Agent costs: service_fee 0.1 U (100000000000000000 base units, chain 97); network_fee 0.002078536 tBNB (2078536000000000 base units, chain 97).
- Baseline: `range-direct-reference-historical-replay@1.0.0`; evidence class historical_replay; observation 0 ms; compute 448958 ns; computed later as a historical replay over frozen bytes; calculation-only and not timing-comparable to the paid lifecycle.
- Raw evidence: [dataset](../evidence/advantage/rangepilot-1189/dataset.json) · [task](../evidence/advantage/rangepilot-1189/task.json) · [input](../evidence/advantage/rangepilot-1189/input.json) · [agent raw](../evidence/advantage/rangepilot-1189/agent-manifest.json) · [agent artifact](../evidence/advantage/rangepilot-1189/agent-artifact.json) · [baseline method](../evidence/advantage/rangepilot-1189/baseline-method.json) · [baseline raw](../evidence/advantage/rangepilot-1189/baseline-observation.json) · [baseline artifact](../evidence/advantage/rangepilot-1189/baseline-artifact.json) · [service_fee evidence](../evidence/advantage/rangepilot-1189/agent-service-cost.json) · [network_fee evidence](../evidence/advantage/rangepilot-1189/agent-network-cost.json) · [compute evidence](../evidence/advantage/rangepilot-1189/baseline-compute-cost.json) · [lifecycle proof](../evidence/advantage/rangepilot-1189/job-1189.json).

| Quality dimension | Agent score (bps) | Baseline score (bps) | Result |
| --- | ---: | ---: | --- |
| Closed artifact, task, snapshot, and source binding (`contract_integrity`) | 10000 | 10000 | tie |
| Independent in-range or out-of-range classification (`position_classification`) | 10000 | 10000 | tie |
| Aligned bounded range derivation (`tick_range_feasibility`) | 10000 | 10000 | tie |
| Conservative token rounding, availability, and budgets (`amount_and_budget_math`) | 10000 | 10000 | tie |
| Gas, slippage, cooldown, and feasibility gates (`constraint_refusals`) | 10000 | 10000 | tie |
| Hold, proposal, or refusal outcome (`bounded_decision`) | 10000 | 10000 | tie |

### GridQuant — `grid`

- Quality: **tie** — 0 agent wins, 0 baseline wins, 5 ties; decisive dimension: none.
- Operator relationship: `same_operator_reference`.
- Task-to-input binding: exact — TaskSpec `inputHash` equals raw-input Keccak-256 `0x043bcd8d3a62679e2cd88150dd55eb271436e99b8aabbbbe8d3d09e6af807a3f`.
- Agent lifecycle boundary: `2026-09-09T11:15:24.382Z` → `2026-09-09T11:16:58.000Z` (93,618 ms), from recorded marketplace start through confirmed submission.
- Agent costs: service_fee 0.1 U (100000000000000000 base units, chain 97); network_fee 0.001783262 tBNB (1783262000000000 base units, chain 97).
- Baseline: `gridquant-independent-historical-replay@1.0.0`; evidence class historical_replay; observation 6 ms; compute 650000 ns; computed later as a historical replay over frozen bytes; calculation-only and not timing-comparable to the paid lifecycle.
- Raw evidence: [dataset](../evidence/advantage/gridquant-1187/dataset.json) · [task](../evidence/advantage/gridquant-1187/task.json) · [input](../evidence/advantage/gridquant-1187/input.json) · [agent raw](../evidence/advantage/gridquant-1187/agent-manifest.json) · [agent artifact](../evidence/advantage/gridquant-1187/agent-artifact.json) · [baseline method](../evidence/advantage/gridquant-1187/baseline-method.json) · [baseline raw](../evidence/advantage/gridquant-1187/baseline-observation.json) · [baseline artifact](../evidence/advantage/gridquant-1187/baseline-artifact.json) · [service_fee evidence](../evidence/advantage/gridquant-1187/agent-service-cost.json) · [network_fee evidence](../evidence/advantage/gridquant-1187/agent-network-cost.json) · [compute evidence](../evidence/advantage/gridquant-1187/baseline-compute-cost.json) · [lifecycle proof](../evidence/advantage/gridquant-1187/agent-negotiate-observation.json) · [terminal proof](../evidence/advantage/gridquant-1187/job-1187.json).

| Quality dimension | Agent score (bps) | Baseline score (bps) | Result |
| --- | ---: | ---: | --- |
| Closed task, manifest, artifact, snapshot, and source binding (`contract_integrity`) | 10000 | 10000 | tie |
| Independent arithmetic or geometric level construction (`grid_level_math`) | 10000 | 10000 | tie |
| Capital allocation, base rounding, and inventory bounds (`allocation_and_inventory`) | 10000 | 10000 | tie |
| Pinned gas, fee, slippage, and adjacent-spread checks (`fee_and_spread_feasibility`) | 10000 | 10000 | tie |
| Plan, no-action, or refusal outcome (`bounded_decision`) | 10000 | 10000 | tie |

### YieldScout — `yield`

- Quality: **tie** — 0 agent wins, 0 baseline wins, 5 ties; decisive dimension: none.
- Operator relationship: `same_operator_reference`.
- Task-to-input binding: exact — TaskSpec `inputHash` equals raw-input Keccak-256 `0xb62982a78e2277cd0fbea463ff8e85043b357bb41fb273a24b39007cfb14b849`.
- Agent lifecycle boundary: `2026-09-09T11:15:24.627Z` → `2026-09-09T11:17:53.000Z` (148,373 ms), from recorded marketplace start through confirmed submission.
- Agent costs: service_fee 0.1 U (100000000000000000 base units, chain 97); network_fee 0.002168994 tBNB (2168994000000000 base units, chain 97).
- Baseline: `direct-yieldscout-pinned-integer-math@1.0.0`; evidence class historical_replay; observation 0 ms; compute 211250 ns; computed later as a historical replay over frozen bytes; calculation-only and not timing-comparable to the paid lifecycle.
- Raw evidence: [dataset](../evidence/advantage/yieldscout-1188/dataset.json) · [task](../evidence/advantage/yieldscout-1188/task.json) · [input](../evidence/advantage/yieldscout-1188/input.json) · [agent raw](../evidence/advantage/yieldscout-1188/agent-manifest.json) · [agent artifact](../evidence/advantage/yieldscout-1188/agent-artifact.json) · [baseline method](../evidence/advantage/yieldscout-1188/baseline-method.json) · [baseline raw](../evidence/advantage/yieldscout-1188/baseline-observation.json) · [baseline artifact](../evidence/advantage/yieldscout-1188/baseline-artifact.json) · [service_fee evidence](../evidence/advantage/yieldscout-1188/agent-service-cost.json) · [network_fee evidence](../evidence/advantage/yieldscout-1188/agent-network-cost.json) · [compute evidence](../evidence/advantage/yieldscout-1188/baseline-compute-cost.json) · [lifecycle proof](../evidence/advantage/yieldscout-1188/agent-negotiate-observation.json) · [terminal proof](../evidence/advantage/yieldscout-1188/paid-jobs-source.json).

| Quality dimension | Agent score (bps) | Baseline score (bps) | Result |
| --- | ---: | ---: | --- |
| Closed artifact, task, snapshot, and source binding (`contract_integrity`) | 10000 | 10000 | tie |
| Independent rate normalization and horizon benefit (`rate_and_horizon_math`) | 10000 | 10000 | tie |
| Disclosed route costs, net benefit, and hold improvement (`disclosed_cost_math`) | 10000 | 10000 | tie |
| Liquidity, capacity, concentration, protocol, and risk exclusions (`market_exclusions`) | 10000 | 10000 | tie |
| Selected migration or hold decision (`bounded_selection`) | 10000 | 10000 | tie |

## Shield high-stakes corpus evaluation

Shield is reported separately because it is a measured specialist evaluation, not one of the four paired marketplace experiments.

- Dataset: `knot-shield-team-corpus-v1`; 6 completed fixtures, including 1 holdout.
- Relationship: The fixtures, ground truth, and manual signal validation are team-owned and were reviewed by the KNOT team.
- Toolchain: slither 0.11.3, 100 detectors; solc 0.8.28.
- Adjudicated result: 2 true positives, 0 false positives, 7 false negatives; precision 2/2 (1.000000), recall 2/9 (0.222222), severity validity 2/2 (1.000000).
- Holdout result: 0 true positives, 0 false positives, 3 false negatives.
- Raw signals: 19 total, 2 confirmed, 2 rejected after manual validation, 15 outside the frozen Shield rules.
- Evidence: [evaluation](../evidence/shield/corpus-v1/evaluation.json) · [capture](../evidence/shield/corpus-v1/raw/capture.json) · [manual validation](../evidence/shield/corpus-v1/manual-validation.json) · [runs](../evidence/shield/corpus-v1/runs.json) · [ground truth](../tests/fixtures/shield/corpus-v1/ground-truth.json) · [raw reentrant-vault](../evidence/shield/corpus-v1/raw/reentrant-vault.json) · [raw unchecked-payout](../evidence/shield/corpus-v1/raw/unchecked-payout.json) · [raw delegate-router](../evidence/shield/corpus-v1/raw/delegate-router.json) · [raw owner-controls](../evidence/shield/corpus-v1/raw/owner-controls.json) · [raw safe-vault](../evidence/shield/corpus-v1/raw/safe-vault.json) · [raw transparent-proxy-holdout](../evidence/shield/corpus-v1/raw/transparent-proxy-holdout.json).
- Limits:
  - all six fixtures, labels, and manual validation decisions are team-owned.
  - manual validation is part of the measured pipeline and rejected mapped analyzer signals before scoring.
  - the corpus is too small and synthetic to establish comprehensive audit quality.
  - the holdout result was scored without changing frozen sources, rules, labels, detector mappings, or Shield logic.
  - results apply only to the frozen fixtures and exact source hashes.
  - precision and recall on this set do not establish comprehensive audit coverage.
  - a holdout fixture count is disclosed but is not statistical evidence of generalization.

## Interpretation limits

- All four finance results are single-input quality observations. A tie is a tie; none establishes superiority or repeatability.
- Three TaskSpecs cryptographically match their committed raw input bytes. HealthGuard's paired paths share the same separately SHA-256-bound input, but its TaskSpec input hash does not match the committed input bytes; the authentic signed-task preimage binding is therefore not established.
- Agent lifecycle durations and baseline calculation measurements have different boundaries. They do not establish a speed, latency, labor, or human-time advantage.
- Service fees are testnet U and network fees are tBNB. They are not revenue, dollars, or evidence of production cost advantage.
- No paired result establishes profit, APY, return, savings, PnL, win rate, execution quality, or future performance.
- The finance artifacts are analysis only. No mainnet position, order, swap, deposit, withdrawal, migration, or repayment was executed.
- Shield is a separate team-owned synthetic-corpus measurement, not a paired marketplace experiment or evidence of comprehensive audit quality.
