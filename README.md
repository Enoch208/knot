<p align="center">
  <img src="assets/brand/knot-logo.png" alt="KNOT" width="168">
</p>

# KNOT

KNOT is an evidence-first marketplace foundation for comparing BNB Chain services on a buyer's actual task, then hiring with explicit scope and verifiable results.

This repository is a pre-production pilot. It contains a deployed control-plane API, four independently callable self-hosted sellers, four deterministic analysis services, and a bounded-authority demo. BSC mainnet is used only for read-only analysis data; seller identity and commerce are on BSC testnet, with no mainnet writes or real funds. Three funded HealthGuard testnet jobs reached submission: permanent-endpoint job `1185` and earlier job `1181` produced verified `NO_DEBT` artifacts and reached terminal `COMPLETED` settlement, while disputed job `1180` produced an invalid-input artifact and returned its full escrow to the buyer through the expiry refund path. Job `1185` is also the first published paired experiment; its agent and non-agent baseline tied on all four independently evaluated quality dimensions.

## Current status

| Component | Category | Current capability | Network scope | Public state |
| --- | --- | --- | --- | --- |
| KNOT API | Control plane | Health, private task creation/read, private job read | Off-chain service | Deployed; `/health` returned HTTP 200 with API and database `AVAILABLE` on 2026-09-09 |
| HealthGuard | Lending health | Analysis | BSC mainnet data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2295`; jobs `1180`, `1181`, and `1185` funded and submitted; `1181` and permanent-endpoint job `1185` verified and settled `COMPLETED`; disputed job `1180` refunded at expiry |
| RangePilot | LP rebalancing | Analysis only | BSC mainnet read-only data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2297`; authenticated signed quote observed; no position transactions or performance history |
| GridQuant | Grid strategy | Analysis only | BSC mainnet read-only data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2298`; authenticated signed quote observed; no orders, swaps, or performance history |
| YieldScout | Yield comparison | Analysis only | BSC mainnet read-only data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2299`; authenticated signed quote observed; no deposits, withdrawals, migrations, or performance history |
| Shield | Contract-risk triage specialist | Analysis only | Offline team-owned Solidity corpus | Slither `0.11.3` plus manual validation measured 2 true positives, 0 false positives, and 7 false negatives; the ERC-1967 holdout missed all 3 expected findings |

The machine-readable source for every statement above is [`evidence/claims.json`](evidence/claims.json).

## What is live

- The KNOT API health endpoint is [https://knot-api.truematchx.com/health](https://knot-api.truematchx.com/health). The observed response reports both `knot-api` and its database as `AVAILABLE`.
- The self-hosted HealthGuard [public agent card](https://knot-health.truematchx.com/.well-known/agent-card.json) returned HTTP 200 on 2026-09-09, advertised OAuth client-credentials authentication, and accepted an authenticated signed-quote request.
- HealthGuard is registered on BSC testnet as ERC-8004 agent `2295`, owned by seller address `0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389`. Its on-chain metadata names KNOT HealthGuard, states its analysis-only limits, and points to the self-hosted agent card.
- RangePilot [agent card](https://knot-range.truematchx.com/.well-known/agent-card.json), GridQuant [agent card](https://knot-grid.truematchx.com/.well-known/agent-card.json), and YieldScout [agent card](https://knot-yield.truematchx.com/.well-known/agent-card.json) each returned HTTP 200 from an isolated, read-only container, required OAuth for invocation, and returned an authenticated signed BSC testnet quote. Their dedicated seller wallets own ERC-8004 agents `2297`, `2298`, and `2299`, respectively.
- The three additional sellers publish standard domain-registration proofs and were discovered by name and ID on 8004scan. At the verification time, 8004scan still reported `is_verified=false`; the live proofs and discovery records are evidence, but no verified badge is claimed.
- RangePilot, GridQuant, and YieldScout each returned a retrievable content-addressed artifact under a separate durable storage prefix. These are authenticated negotiation and delivery smokes, not paid-job, uptime, latency, earnings, or performance benchmarks.
- An authenticated negotiation returned an accepted, wallet-signed quote for `100000000000000000` base units (`0.1 U`) on chain `97`, bound to verifying contract `0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de`.
- Testnet job [`1180`](evidence/testnet/healthguard-job-1180.json) was funded and submitted with matching deliverable integrity, but its artifact correctly returned `INVALID_REQUEST` / `INVALID_JSON` after the signed JSON task was changed by dependency sanitization. The buyer disputed it, and the [expiry refund transaction](https://testnet.bscscan.com/tx/0xa700168057f303090aa44e758e05857b41a2175e3a3643ab1cd366e34cd11469) returned the full `0.1 U` escrow to the buyer.
- Testnet job [`1181`](evidence/testnet/healthguard-job-1181.json) was funded and submitted. Its deliverable matched both the content-addressed URL and on-chain manifest hash, passed the closed artifact schema, matched the signed task and pinned snapshot identity, and returned `NO_DEBT` for that snapshot. The [settlement transaction](https://testnet.bscscan.com/tx/0xa3c67eafa69c2b2b2307989efd0df8cbd79fe036f763bdd87b6c4a1816c4483a) confirmed, transferred `0.1 U` from commerce escrow to the seller, and moved the job to terminal `COMPLETED` state.
- Permanent-endpoint job [`1185`](evidence/advantage/healthguard-1185/job-1185.json) repeated the paid flow against BSC mainnet block `120862609`. Its content-addressed artifact passed schema, task, snapshot, URL-digest, and on-chain manifest-hash checks before the 900-second challenge window elapsed. The [settlement transaction](https://testnet.bscscan.com/tx/0xe0e7ffbdd4cddad0f852d3710dde30d734416f30480378edfe227f41823e92ca) then transferred exactly `0.1 U` from testnet escrow to the seller and moved the job to `COMPLETED`.
- The job `1185` [`paired dataset`](evidence/advantage/healthguard-1185/dataset.json) uses the exact same pinned request for HealthGuard and an independent direct-integer-math baseline. An independent evaluator awarded both paths `10000` basis points on contract integrity, risk classification, deterministic math, and bounded recommendation, producing an honest four-dimension tie. The measured scopes were `43,605 ms` from quote start to confirmed agent submission and `1 ms` for baseline calculation after both paths received the prepared input; these different scopes do not establish a speed advantage.
- The [`bounded-authority demo`](evidence/testnet/bounded-authority-grant-revoke.json) granted one temporary BSC testnet session permission to call only `U.balanceOf(address)`, with a `0.005 tBNB` hourly native-fee cap and no token-spend permission. The allowed read [confirmed](https://testnet.bscscan.com/tx/0x3711da4313559f740b6c16823ba1ad3a5274af379c798d80b93049fe9c14db37), `totalSupply()` was rejected, the permission was [revoked](https://testnet.bscscan.com/tx/0x7d966971ec1b4be35c2f6abe49ee0dfb0e2c67d881325e563fa707f80e21872f), and the formerly allowed read was then rejected. The U balance and commerce allowance were unchanged across the run.

These observations support two completed HealthGuard flows on BSC testnet from negotiation through funding, verified delivery, and terminal settlement, including one against the permanent endpoint. The other three services have independently callable public surfaces, dedicated testnet identities, authenticated quotes, and durable smoke artifacts, but no paid job has completed for them. The one paired HealthGuard run establishes a quality tie on one no-debt input, not repeatability, superiority, mainnet payment, domain transaction execution, or comparative performance for the other categories.

## Why this structure matters

KNOT's current advantage remains structural; its first measured HealthGuard comparison is a quality tie, not a performance win:

- task and result schemas are closed, versioned, and use integer base units;
- analysis data, payment, identity, and execution networks are kept distinct;
- incompatible or ambiguous commerce configuration disables writes;
- unknown, stale, unsupported, and unavailable inputs remain explicit instead of becoming optimistic results;
- work state and financial state are recorded independently.

These properties are covered by repository tests. The published HealthGuard pair measures deterministic quality, timing, and recorded costs for one no-debt input. It does not support a claim of superior yield, PnL, win rate, execution quality, or latency, and no live trading dataset has been published.

## Verify

The shortest local verification is:

```sh
npm ci
npm run check
```

Network compatibility and optional integration checks are documented in [`REPRODUCE.md`](REPRODUCE.md). The default test run uses deterministic fixtures and does not submit blockchain transactions.

The Shield measurement preserves all six raw Slither outputs and every manual validation decision. This read-only command verifies those hashes and decisions, compiles the frozen sources, and independently reruns the scorer against the committed measured runs:

```sh
npm run shield:verify
```

Across nine adjudicated findings, the validated pipeline recorded 2 true positives, 0 false positives, and 7 false negatives: precision `2/2`, recall `2/9`, and severity validity `2/2`. Manual review rejected two mapped analyzer signals before scoring, while 15 raw signals were outside the frozen Shield rules. The holdout recorded 0 true positives, 0 false positives, and 3 false negatives. Ground-truth labels were not supplied to Slither, and no rule, fixture, label, mapping, or Shield logic was changed after the holdout output was observed.

## Demo boundary

The HealthGuard BSC testnet paid-flow milestone is supported by jobs `1181` and `1185`; job `1185` used the permanent endpoint and supplies the first paired dataset. Job `1180` remains openly recorded as a disputed invalid-input submission whose full escrow was recovered through the expiry refund path. RangePilot, GridQuant, and YieldScout are live analysis-only sellers, but their current evidence stops at authenticated signed quotes and retrieved artifacts rather than paid commerce. The authority demo covers one temporary, revoked testnet permission and does not claim mainnet execution or production security. Shield's measured result is a small, team-owned synthetic corpus with `2/9` recall and a `0/3` holdout result, not evidence of comprehensive audit quality. The paired HealthGuard result is one honest quality tie, so repeatability, superiority, mainnet payment readiness, domain execution, and strategy performance remain outside these claims.
