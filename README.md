<p align="center">
  <img src="assets/brand/knot-logo.png" alt="KNOT" width="168">
</p>

# KNOT

KNOT is an evidence-first marketplace foundation for comparing BNB Chain services on a buyer's actual task, then hiring with explicit scope and verifiable results.

This repository is a pre-production pilot. It contains a deployed control-plane API, one self-hosted BSC testnet seller, and four deterministic analysis services. Two funded testnet jobs reached submission: job `1181` produced a verified `NO_DEBT` artifact and reached terminal `COMPLETED` settlement, while disputed job `1180` produced an invalid-input artifact and returned its full escrow to the buyer through the expiry refund path. No comparative performance benchmark is claimed.

## Current status

| Component | Category | Current capability | Network scope | Public state |
| --- | --- | --- | --- | --- |
| KNOT API | Control plane | Health, private task creation/read, private job read | Off-chain service | Deployed; `/health` returned HTTP 200 with API and database `AVAILABLE` on 2026-09-09 |
| HealthGuard | Lending health | Analysis | BSC mainnet data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2295`; jobs `1180` and `1181` funded and submitted; `1181` verified and settled `COMPLETED`; disputed job `1180` refunded at expiry |
| RangePilot | LP rebalancing | Analysis only | BSC mainnet or testnet snapshots | Implemented and fixture-tested; not publicly deployed |
| GridQuant | Grid strategy | Analysis only | BSC mainnet, allowlisted WBNB/USDT PancakeSwap v3 pool | Implemented and fixture-tested; no trades or performance history |
| YieldScout | Yield comparison | Analysis only | BSC mainnet, same-asset Venus and Aave v3 supply markets | Implemented and fixture-tested; not publicly deployed |

The machine-readable source for every statement above is [`evidence/claims.json`](evidence/claims.json).

## What is live

- The KNOT API health endpoint is [https://knot-api.truematchx.com/health](https://knot-api.truematchx.com/health). The observed response reports both `knot-api` and its database as `AVAILABLE`.
- The self-hosted HealthGuard [public agent card](https://knot-health.truematchx.com/.well-known/agent-card.json) returned HTTP 200 on 2026-09-09, advertised OAuth client-credentials authentication, and accepted an authenticated signed-quote request.
- HealthGuard is registered on BSC testnet as ERC-8004 agent `2295`, owned by seller address `0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389`. Its on-chain metadata names KNOT HealthGuard, states its analysis-only limits, and points to the self-hosted agent card.
- An authenticated negotiation returned an accepted, wallet-signed quote for `100000000000000000` base units (`0.1 U`) on chain `97`, bound to verifying contract `0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de`.
- Testnet job [`1180`](evidence/testnet/healthguard-job-1180.json) was funded and submitted with matching deliverable integrity, but its artifact correctly returned `INVALID_REQUEST` / `INVALID_JSON` after the signed JSON task was changed by dependency sanitization. The buyer disputed it, and the [expiry refund transaction](https://testnet.bscscan.com/tx/0xa700168057f303090aa44e758e05857b41a2175e3a3643ab1cd366e34cd11469) returned the full `0.1 U` escrow to the buyer.
- Testnet job [`1181`](evidence/testnet/healthguard-job-1181.json) was funded and submitted. Its deliverable matched both the content-addressed URL and on-chain manifest hash, passed the closed artifact schema, matched the signed task and pinned snapshot identity, and returned `NO_DEBT` for that snapshot. The [settlement transaction](https://testnet.bscscan.com/tx/0xa3c67eafa69c2b2b2307989efd0df8cbd79fe036f763bdd87b6c4a1816c4483a) confirmed, transferred `0.1 U` from commerce escrow to the seller, and moved the job to terminal `COMPLETED` state.

These observations support one HealthGuard flow on BSC testnet from negotiation through funding, verified delivery, and terminal settlement. They do not establish repeatability, coverage of the other services, mainnet payment, or domain transaction execution.

## Why this structure matters

KNOT's current advantage is structural rather than a measured performance win:

- task and result schemas are closed, versioned, and use integer base units;
- analysis data, payment, identity, and execution networks are kept distinct;
- incompatible or ambiguous commerce configuration disables writes;
- unknown, stale, unsupported, and unavailable inputs remain explicit instead of becoming optimistic results;
- work state and financial state are recorded independently.

These properties are covered by repository tests. No claim of superior yield, PnL, win rate, execution quality, or latency is made because no benchmark or live trading dataset has been published.

## Verify

The shortest local verification is:

```sh
npm ci
npm run check
```

Network compatibility and optional integration checks are documented in [`REPRODUCE.md`](REPRODUCE.md). The default test run uses deterministic fixtures and does not submit blockchain transactions.

## Submission boundary

The single-service HealthGuard BSC testnet paid-flow milestone is supported by job `1181`. Job `1180` remains openly recorded as a disputed invalid-input submission whose full escrow was recovered through the expiry refund path. Broader marketplace coverage, repeatability, mainnet payment readiness, and strategy performance remain outside this claim.
