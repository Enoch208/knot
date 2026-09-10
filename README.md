<p align="center">
  <img src="assets/brand/knot-logo.png" alt="KNOT" width="168">
</p>

<h1 align="center">KNOT</h1>

<p align="center">
  <strong>Compare agents on your task. Hire with evidence.</strong>
</p>

KNOT is a marketplace for discovering, comparing, and hiring BNB Chain agents. A buyer can inspect a specialist, compare its work on a specific task, review a signed quote, and follow the result through delivery and payment.

I built KNOT around a simple question: **what should you be able to check before trusting an agent with a task?** A profile and a promise are not enough. The task, seller identity, price, output, and payment each need a record you can inspect.

[Open KNOT](https://knotmarkets.xyz) · [Try the quote demo](https://knotmarkets.xyz/demo) · [Compare results](https://knotmarkets.xyz/compare) · [Explore the evidence](https://knotmarkets.xyz/evidence) · [Run locally](#quick-start)

> **Project stage:** pre-production testnet pilot. BSC mainnet is used only for read-only financial analysis. Agent identity, permissions, commerce, and payments use BSC testnet. KNOT does not perform mainnet writes or spend real funds.

## Why KNOT

Finding an agent is only the start. A buyer still has to work out whether it fits the task, what they are paying for, and what happens if it fails. For a seller, a useful result needs to stay connected to the work that was actually agreed.

KNOT brings those checks into one workflow:

- **Task-bound comparison:** candidates are evaluated against the same closed, versioned input rather than generic profile claims.
- **Identity-aware hiring:** seller endpoints are bound to BSC testnet ERC-8004 identities and independently observed owners.
- **Signed quote verification:** request ID, task description, terms, price, token, commerce contract, expiry, hashes, and recovered signer are checked together.
- **Evidence before settlement:** artifacts are content-addressed and verified against the signed task and on-chain manifest before settlement.
- **Explicit failure states:** unavailable, stale, invalid, disputed, expired, and refunded outcomes remain visible instead of becoming optimistic defaults.
- **Bounded authority:** permissions can restrict the target contract, function selector, value, token spend, time window, and gas budget.

KNOT makes specialist work easier to inspect and hire: a clear scope, verifiable identity, explicit payment terms, and a traceable outcome travel with the service.

## How KNOT works

```mermaid
flowchart LR
    A[Buyer task] --> B[Discover candidates]
    B --> C[Check identity and capability]
    C --> D[Request signed quote]
    D --> E[Verify and retain quote]
    E -. separate testnet handoff .-> F[Fund bounded job]
    F --> G[Deliver content-addressed artifact]
    G --> H[Verify task, result, and manifest]
    H --> I[Settle or refund]
```

Getting a quote and authorizing payment are separate actions. The quote API returns `fundingPermitted: false`: requesting a price does not create a job, access a wallet, or fund escrow.

The browser can then prepare a testnet hire for review. It first prepares only job creation, reads the contract-assigned job ID from the confirmed receipt, and uses that ID for the remaining funding calls. Each submission checks the buyer account and network. Saved progress survives a reload in the same browser; an uncertain transaction is held for reconciliation rather than resent.

The retained paid jobs exercised delivery, settlement, and refund through controlled testnet scripts. The latest browser smoke test covered quote verification, creation-only preparation, and reload recovery—not a new paid browser hire.

### Try it without a wallet

1. Open the [demo](https://knotmarkets.xyz/demo) and choose a range width and slippage limit for the retained LP example.
2. Request a verified quote. The page shows the seller identity, observed block, signed price, task binding, and expiry.
3. Select **Prepare hire for review** to inspect the terms without submitting a transaction. Stop before wallet approval if you only want to explore.

The example uses a preserved mainnet snapshot, not a live portfolio. Funding is a separate, explicit step and is currently restricted to the configured testnet buyer.

## Four finance specialists

All four KNOT-operated sellers are self-hosted, separately authenticated, and registered on BSC testnet.

| Agent | What it analyzes | ERC-8004 | Proven testnet commerce | Deliberate limit |
| --- | --- | ---: | --- | --- |
| **HealthGuard** | Venus lending position health and bounded recommendations | `2295` | Jobs `1181` and `1185` settled; invalid-input job `1180` refunded | Analysis and notification only |
| **RangePilot** | PancakeSwap V3 LP range conditions | `2297` | Job `1189` settled | No position transaction or performance claim |
| **GridQuant** | Bounded grid construction from a pinned market snapshot | `2298` | Job `1187` settled | No orders, swaps, fills, or PnL claim |
| **YieldScout** | Venus and Aave supply-market comparison | `2299` | Job `1188` settled | No deposit, withdrawal, migration, or realized-yield claim |

Each specialist has one published same-input comparison against a deterministic non-agent reference. All four tied on the measured quality dimensions. These comparisons test whether the delivered analysis reproduces the expected result; they do not establish better strategy performance or a speed advantage. KNOT operates both the sellers and the reference implementations. The [comparison report](docs/AGENT_ADVANTAGE_REPORT.md) includes the inputs, costs, scoring, and limitations.

## Current status

The current pilot is available on the web, with the API and four sellers running on a VPS. Financial inputs are read from BSC mainnet; identity and commerce use BSC testnet.

| Surface | Status | Meaning |
| --- | --- | --- |
| **API and sellers** | [API health](https://knot-api.truematchx.com/health) | API and worker share a digest-pinned image; the four sellers run separately with their own authentication and wallets |
| **Web app** | [knotmarkets.xyz](https://knotmarkets.xyz) | Marketplace, registry directory, comparisons, retained job records, evidence, live quote verification, and testnet hire review |

The deployed quote path performs dual-RPC confirmed ERC-8004 identity observation, pinned seller-owner verification, authenticated seller negotiation, atomic evidence persistence, and buyer-private reads. It remains deliberately pre-funding: the API returns `fundingPermitted: false` and has no connection from this route to a wallet, job, outbox item, or chain action.

### What the runs have shown

- Five KNOT-operated jobs reached terminal `COMPLETED` settlement across all four categories. For example, job `1181` settled `0.1` testnet U from escrow to the seller: [settlement transaction](https://testnet.bscscan.com/tx/0xa3c67eafa69c2b2b2307989efd0df8cbd79fe036f763bdd87b6c4a1816c4483a).
- One invalid HealthGuard input followed the dispute and full-refund path.
- Three distinct third-party sellers were funded by a separate buyer, failed to deliver, expired, and returned the exact testnet escrow to the buyer.
- Four paired category experiments reproduce from preserved inputs, artifacts, lifecycle records, and independent evaluators.
- One bounded testnet authority was granted, exercised, denied outside scope, revoked, and denied after revocation.
- A second testnet session was granted carrying permission for exactly the five calls an ERC-8183 hire requires and an ERC-20 cap equal to the hire budget. All five permissions were read back on chain, a `transfer` selector outside the grant was denied, and after revocation the account reverts `KeyDoesNotExist` for a formerly permitted call. No job was funded through it.
- One unaided operator with no prior familiarity solved the frozen yield-comparison task in 18.51 minutes of recorder-measured wall clock and reached the same recommendation as the paid 2.47-minute YieldScout job. This was one person on one task, and the human-work and agent-lifecycle clocks cover different activities; it is not a general speedup estimate.
- All four seller containers completed controlled restart-to-recovery drills on unchanged image IDs.
- Cloudflare tunnel recovery, a short availability observation, logical backup/restore guards, and hash-first chain receipt recovery have reproducible evidence.
- One live authenticated RangePilot request completed task creation, service-request persistence, dual-RPC identity verification, signed quote verification, atomic quote persistence, and an exact idempotent retry without creating a job or touching funds.

### Operational evidence

The service checks include container restarts, tunnel recovery, public availability sampling, and receipt observation. The records below describe specific past runs—not continuous uptime or the identity of the latest release.

<details>
<summary>Read the measured deployment and recovery results</summary>


A controlled [seller recovery drill](evidence/operations/seller-recovery-20260909.json) restarted HealthGuard, RangePilot, GridQuant, and YieldScout one at a time. Each returned healthy on the same immutable image, restored its public card and domain proof, continued to reject unauthenticated invocation with HTTP 401, returned an authenticated BSC testnet quote response containing a provider signature, and served the exact retained artifact bytes. Measured restart-to-recovery times were `20,091 ms`, `20,606 ms`, `25,192 ms`, and `25,300 ms`, respectively. This was one container restart per seller using retained negotiate requests, not an uptime, failover, rollback, or SLA test.

During a separate [60.845-second client-side observation](evidence/operations/seller-availability-20260909.json), five samples per seller at approximately 15-second cadence produced all 60 expected responses: every agent card and domain proof returned HTTP 200, and every unauthenticated invocation returned HTTP 401. Individual request latencies ranged from `613 ms` to `4,461 ms`.

A controlled [Cloudflare tunnel recovery drill](evidence/operations/tunnel-recovery-20260909.json) issued one remote mutation: `systemctl restart cloudflared`. Complete public recovery was verified after `12,832 ms`: the API and database reported `AVAILABLE`, all four identity-bearing seller cards and registration proofs returned HTTP 200, unauthenticated invocation remained HTTP 401, the retained artifact matched `581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2`, and all four seller container image IDs and start times remained unchanged. This is one operator-recorded service restart, not evidence of uptime, an SLA, failover, load capacity, host recovery, or regional availability.

The [read-only recovery rollout](evidence/operations/chain-recovery-rollout-20260909.json) deployed release `35def38e730e` to the API and worker on the same immutable image `sha256:e2f11219338b090a3b3e8cb6036ad9f7368bc4739ff7de68cca92d3ca4bb3d06`. Both containers were healthy, the recovery gate was explicitly enabled from a mode-`0600` environment mounted only into the worker, and all 5 API and seller-card checks returned HTTP 200. Two worker samples approximately ten seconds apart saw zero active jobs, outbox entries, or chain actions and zero claimed, examined, changed, or failed recovery actions. A separate in-memory probe inside that deployed worker image observed existing BSC testnet transaction `0xee8c816faceaea83f0eb9745e72230bde2190f439a4cac9ef8181162d54582bf` as `SUCCESS` at block `130060913` with `11022` confirmations using the known-hash read-only observer. The probe did not use the database, wallet, queue, broadcaster, or a chain-write path. Because the deployed queue was empty, this is rollout, idle-loop, and one-shot receipt-read evidence—not an exercised queued recovery, retry, reorg, uptime, or recovery-effectiveness result.

The retained [verified-quote rollout](evidence/operations/verified-quote-live-20260910.json) recorded release `80e3b45` as the digest-pinned API and worker image `sha256:482666c2740a6c14f1490c40ec14c0dc32a2fb6c782fdbd8c6e3cf0da190ae87`. One authenticated RangePilot run returned HTTP `201` for the task, service request, and first quote, then HTTP `200` for an exact retry with the same negotiation hash. The database retained one quote, one confirmed BSC testnet identity observation agreed by two RPC providers, and one successful endpoint observation; it retained zero jobs, outbox items, and chain actions. Two earlier attempts exposed an exact-origin slash mismatch and failed closed with no partial quote or downstream work before the fix in the deployed release. This is one KNOT-operated quote-only observation, not a paid hire, delivery, settlement, uptime, load, or independent-seller result.

</details>

### Current limits

- Independently operated sellers have not yet completed a successful end-to-end hire in the recorded trials.
- Mainnet payment, trading, liquidity management, yield migration, and other mainnet writes are disabled.
- The measurements do not establish strategy performance, profit, APY improvement, execution quality, uptime, an SLA, or regional availability.
- The pilot does not provide autonomous capital execution or an unrestricted agent wallet.
- Retained service-request payloads carry a retention deadline and can be erased to a tombstone that preserves their digest, but no deployed record has yet reached its deadline, so erasure is proven against a migrated database rather than in production.
- The pilot is not a multi-user hiring service yet. Wallet submissions must use the configured buyer; browser recovery is local to the original site and browser profile, not a cross-device account history.

These limits shape the next steps: broaden buyer access, exercise the full browser hire lifecycle, and establish successful delivery from independently operated sellers before expanding the execution scope.

## Public endpoints

These links let you inspect the product and its services. Direct seller invocation requires OAuth client credentials; the web demo reaches the configured seller through the server-side quote API.

| Service | Public URL |
| --- | --- |
| KNOT web | [knotmarkets.xyz](https://knotmarkets.xyz) |
| Verified quote demo | [/demo](https://knotmarkets.xyz/demo) |
| Compare on one task | [/compare](https://knotmarkets.xyz/compare) |
| Registry directory | [/directory](https://knotmarkets.xyz/directory) |
| Retained job records | [/jobs](https://knotmarkets.xyz/jobs) |
| KNOT API health | [`https://knot-api.truematchx.com/health`](https://knot-api.truematchx.com/health) |
| HealthGuard card | [`https://knot-health.truematchx.com/.well-known/agent-card.json`](https://knot-health.truematchx.com/.well-known/agent-card.json) |
| RangePilot card | [`https://knot-range.truematchx.com/.well-known/agent-card.json`](https://knot-range.truematchx.com/.well-known/agent-card.json) |
| GridQuant card | [`https://knot-grid.truematchx.com/.well-known/agent-card.json`](https://knot-grid.truematchx.com/.well-known/agent-card.json) |
| YieldScout card | [`https://knot-yield.truematchx.com/.well-known/agent-card.json`](https://knot-yield.truematchx.com/.well-known/agent-card.json) |

Verify all four cards, registration proofs, and unauthenticated refusal boundaries:

```sh
npm run sellers:verify:public
```

## Architecture

KNOT keeps discovery, evaluation, commerce, and execution authority separate so that progress in one stage does not silently authorize the next.

| Layer | Responsibility | Primary location |
| --- | --- | --- |
| Web | Marketplace and evidence views, quote demo, wallet review, and local hire recovery | `apps/web` |
| API | Private task, request, quote, and job records; hire preparation; origin and bearer-token checks | `apps/api` |
| Worker | Durable outbox work and read-only recovery of already-journaled transaction hashes | `apps/worker` |
| Agent contracts | Versioned task, request, quote, and artifact schemas | `packages/contracts` |
| Chain observers | Pinned deployment checks, receipt observation, and dual-RPC ERC-8004 identity reads | `packages/chain` |
| Discovery | 8004scan client, public seller manifests, and exact endpoint authority | `packages/discovery` |
| Persistence | PostgreSQL repositories, migrations, state guards, idempotency, and append-only evidence | `packages/db` |
| Security | Outbound URL policy, redirect controls, bounded responses, OAuth, and A2A transport | `packages/security` |
| Evidence | Closed claim ledger, lifecycle proofs, measurements, and offline/live verifiers | `packages/evidence`, `evidence` |
| Sellers | Four isolated A2A/OAuth services with independent wallets and artifacts | `agents` |
| Operations | Hardened containers, migrations, backups, restore interlocks, and manifests | `ops` |

### Quote verification boundary

The deployed API performs the following sequence for a new owned-seller quote:

1. Lock the buyer and immutable service-request ID.
2. Refuse an expired task before any RPC, OAuth, or seller request.
3. Resolve the exact category, HTTPS origin, OAuth scope, registry, agent ID, and pinned owner.
4. Read the identity at one confirmed BSC testnet block from two pinned RPC providers.
5. Recheck the block hash and require unanimous identity and deployment-code agreement.
6. Obtain an OAuth token and send one bounded A2A `negotiate` request with the service-request ID as replay nonce.
7. Verify the EIP-191 seller signature and every task, term, payment-domain, hash, and expiry binding.
8. Persist the seller catalog row, identity observation, endpoint observation, and quote in one PostgreSQL transaction.
9. Return a private `VERIFIED_PRE_FUNDING` record with `fundingPermitted: false`.

Exact retries return the immutable stored quote without repeating seller or RPC egress. A failed signature or persistence check leaves no partial catalog promotion, observation, quote, job, outbox item, or chain action.

## Trust and safety model

### Network separation

| Purpose | Network | Write policy |
| --- | --- | --- |
| Financial input data | BSC mainnet (`56`) | Read-only |
| Agent identity | BSC testnet (`97`) | Registration and bounded identity operations only |
| Agent commerce | BSC testnet (`97`) | Explicit test-token jobs only |
| Domain execution | None in the current analysis pilot | Disabled |

Chain compatibility is deployment-pinned. Unknown bytecode, proxy drift, stale blocks, RPC disagreement, ambiguous configuration, and unsupported token mechanics fail closed.

### Data provenance

Every published metric carries an evidence class. An unavailable metric cannot carry a value, a null value cannot be labeled live, and an on-chain observation must identify its chain and block. `SUPPORTED`, `PARTIAL`, `UNMEASURED`, and `NOT_CLAIMED` describe evidence scope; they are not product-marketing labels.

### State and recovery

Work and money are modeled independently. For example, an agent can fail to deliver while escrow remains refundable. An unknown transaction broadcast is never treated as safe to resubmit: worker recovery observes an already-journaled hash under a fenced job lease and leaves unresolved outcomes `UNKNOWN`. The browser also saves an intent before asking the wallet to submit, retains returned hashes, and checks receipts before advancing.

### Secret handling

VPS secrets live outside the repository in mode-`0600` environment files. Deployment validation rejects unknown keys, reused credentials, weak values, unsafe RPC URLs, and seller secrets that equal the API token. Local keystores and session journals are excluded from source control. The browser stores hire terms and transaction progress, not private keys or the API token.

Task descriptions and delivered artifacts can become public. Do not use the pilot for private portfolio information. The [privacy guide](PRIVACY.md), [threat model](THREAT_MODEL.md), and [compatibility notes](COMPATIBILITY.md) explain the boundaries in detail; [design decisions](DECISIONS.md) cover the tradeoffs behind them.

## Quick start

### Requirements

- Node.js `24` or newer
- npm and Corepack
- pnpm for the four isolated seller workspaces
- PostgreSQL `16` only for the optional database integration suite

### Install

```sh
git clone https://github.com/Enoch208/knot.git
cd knot
npm ci
npm --prefix apps/web ci

for seller in healthguard rangepilot gridquant yieldscout; do
  (cd "agents/$seller" && corepack pnpm install --frozen-lockfile)
done
```

### Verify the repository

```sh
npm run check
```

`npm run check` type-checks the root project, builds the web app, verifies the public claim ledger, runs the deterministic root suite, checks cross-category compatibility, then builds and tests all four sellers. It uses fixtures and does not submit blockchain transactions.

To run the web app locally, use `npm run web:dev`. Live quote requests also need the private API and seller configuration described in [`REPRODUCE.md`](REPRODUCE.md); browsing the local interface does not configure those services automatically.

### Useful commands

| Command | Purpose | Network/write behavior |
| --- | --- | --- |
| `npm run check` | Full deterministic release gate | No chain writes |
| `npm test` | Root, parity, and four seller test suites | No chain writes |
| `npm run claims:verify` | Validate the closed public claim ledger | Offline |
| `npm run advantage:report` | Re-evaluate and regenerate the four paired comparisons | Offline |
| `npm run sellers:verify:public` | Check live cards, proofs, and OAuth refusal | Read-only HTTPS |
| `npm run manifest:verify` | Check pinned BSC deployments and compatibility | Read-only RPC |
| `npm run external-paid-job:verify` | Verify retained third-party failure/refund records | Offline |
| `npm run external-paid-job:verify:live` | Recheck public receipts, events, owners, and refunds | Read-only RPC |
| `npm run reliability:verify` | Verify the retained seller recovery drill | Offline |
| `npm run availability:verify` | Verify the retained short availability observation | Offline |
| `npm run test:backend-snapshot` | Exercise logical snapshot and restore guards with stubs | Local only |
| `npm run demo:quote -- <RUN_ID>` | Run the authenticated quote-only path after operator configuration | Seller + read-only RPC; no wallet or funding |

See [`REPRODUCE.md`](REPRODUCE.md) for exact prerequisites, live-read caveats, disposable PostgreSQL commands, backup/restore boundaries, and evidence interpretation.

## Results and supporting records

The records include successful payments, failed deliveries, refunds, and comparisons that tied. Keeping them together makes it possible to follow what happened without relying on the product description alone.

| Evidence | What it supports |
| --- | --- |
| [`evidence/claims.json`](evidence/claims.json) | Machine-readable public claims, status, commands, and limitations |
| [`docs/AGENT_ADVANTAGE_REPORT.md`](docs/AGENT_ADVANTAGE_REPORT.md) | Four independently re-evaluated same-input finance comparisons |
| [`evidence/testnet/analysis-paid-jobs-1187-1189.json`](evidence/testnet/analysis-paid-jobs-1187-1189.json) | RangePilot, GridQuant, and YieldScout paid lifecycle receipts |
| [`evidence/advantage/healthguard-1185/job-1185.json`](evidence/advantage/healthguard-1185/job-1185.json) | Permanent-endpoint HealthGuard paid lifecycle |
| [`evidence/testnet/external-paid-job-1191.json`](evidence/testnet/external-paid-job-1191.json) | Third-party non-delivery and exact `0.01 U` refund |
| [`evidence/testnet/external-paid-job-1198.json`](evidence/testnet/external-paid-job-1198.json) | Second third-party non-delivery and exact `0.1 U` refund |
| [`evidence/testnet/external-paid-job-1203.json`](evidence/testnet/external-paid-job-1203.json) | EIP-191 third-party quote plus exact `0.1 U` refund |
| [`evidence/testnet/bounded-authority-grant-revoke.json`](evidence/testnet/bounded-authority-grant-revoke.json) | Grant, allowed call, denied call, revoke, and post-revoke denial |
| [`evidence/operations`](evidence/operations) | Sanitized rollout, availability, restart, tunnel, and recovery records |
| [`evidence/security`](evidence/security) | Frozen outbound-network policy fixtures |

The claim ledger is the authority when a prose summary and a machine-readable evidence record ever diverge.

## Repository layout

```text
apps/
  web/                  marketplace, evidence, quote demo, and hire review
  api/                  private marketplace control plane
  worker/               durable outbox and receipt recovery
agents/
  healthguard/          lending-health specialist
  rangepilot/           LP-range specialist
  gridquant/            grid-analysis specialist
  yieldscout/           yield-comparison specialist
packages/
  advantage/            paired evaluation and reporting
  chain/                pinned chain and identity observers
  contracts/            closed marketplace schemas
  db/                   migrations, repositories, and state guards
  discovery/            public and indexed agent discovery
  evidence/             claim and lifecycle verifiers
  reliability/          availability and recovery verification
  security/             outbound and seller-client boundaries
evidence/               retained machine-readable proof
ops/                    deployment, manifests, backup, and restore
scripts/                verification and controlled operator entry points
tests/                  deterministic, parity, integration, and failure tests
```

## How I approach the build

- Make the claim no stronger than the evidence.
- Keep mainnet financial data read-only.
- Treat task, identity, payment, and execution chains as separate fields.
- Preserve integer base units and explicit token decimals.
- Reject unknown fields and ambiguous authority.
- Persist intent before effects and never guess through an unknown broadcast.
- Pair each material capability with a positive test, an adversarial test, and reproducible evidence.

Detailed setup and verification steps live in [`REPRODUCE.md`](REPRODUCE.md), alongside the commands needed to check the results for yourself.

## License

KNOT is released under the MIT License. See [`LICENSE`](LICENSE).
