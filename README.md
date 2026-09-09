<p align="center">
  <img src="assets/brand/knot-logo.png" alt="KNOT" width="168">
</p>

# KNOT

KNOT is an evidence-first marketplace foundation for comparing BNB Chain services on a buyer's actual task, then hiring with explicit scope and verifiable results.

This repository is a pre-production pilot. It contains a deployed control-plane API, one temporarily deployed BSC testnet seller, and four deterministic analysis services. It does **not** yet contain evidence of a funded end-to-end purchase or comparative performance benchmarks.

## Current status

| Component | Category | Current capability | Network scope | Public state |
| --- | --- | --- | --- | --- |
| KNOT API | Control plane | Health, private task creation/read, private job read | Off-chain service | Deployed; `/health` returned HTTP 200 with API and database `AVAILABLE` on 2026-09-09 |
| HealthGuard | Lending health | Analysis | BSC mainnet data; BSC testnet identity and commerce | Agent card live; ERC-8004 agent `2295`; authenticated signed quote observed; no funded job demonstrated |
| RangePilot | LP rebalancing | Analysis only | BSC mainnet or testnet snapshots | Implemented and fixture-tested; not publicly deployed |
| GridQuant | Grid strategy | Analysis only | BSC mainnet, allowlisted WBNB/USDT PancakeSwap v3 pool | Implemented and fixture-tested; no trades or performance history |
| YieldScout | Yield comparison | Analysis only | BSC mainnet, same-asset Venus and Aave v3 supply markets | Implemented and fixture-tested; not publicly deployed |

The machine-readable source for every statement above is [`evidence/claims.json`](evidence/claims.json).

## What is live

- The KNOT API health endpoint is [https://knot-api.truematchx.com/health](https://knot-api.truematchx.com/health). The observed response reports both `knot-api` and its database as `AVAILABLE`.
- The HealthGuard [public agent card](https://bnbagent-api.bnbchain.world/v1/rt/01M22N9QVXCSAQ8YVH1Z9VGNET/.well-known/agent-card.json) returned HTTP 200 on 2026-09-09. The temporary trial deployment reports an expiry of `2026-09-11T08:42:34Z`; availability after that time is not claimed.
- HealthGuard is registered on BSC testnet as ERC-8004 agent `2295`, owned by seller address `0xaF7474d06f171e6fD72fc5aF114b34f3D5AF8389`.
- An authenticated negotiation returned an accepted, wallet-signed quote for `100000000000000000` base units (`0.1 U`) on chain `97`, bound to verifying contract `0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de`.

A signed quote proves that negotiation and signing work. It does not prove funding, delivery, verification, settlement, or seller earnings. No mainnet payment or domain transaction execution is claimed.

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

The next evidence milestone is one funded BSC testnet flow: negotiate, create and fund a job, deliver the artifact, read it back from chain, verify it, and record settlement state. Until that evidence exists, KNOT should be evaluated as a tested analysis and marketplace foundation with a live testnet negotiation surface—not as a completed paid marketplace or a proven strategy-performance product.
