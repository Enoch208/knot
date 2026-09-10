# Reproduce the current evidence

This guide separates deterministic tests, offline evidence checks, live read-only observations, and operator-triggered mutations. Most commands require no secret; the authenticated quote-only demo and controlled recovery drills are explicitly marked. Run commands from the repository root with Node.js 24 or newer.

## Build and deterministic tests

```sh
npm ci
for seller in healthguard rangepilot gridquant yieldscout; do
  (cd "agents/$seller" && corepack pnpm install --frozen-lockfile)
done
npm run check
```

Each seller is an isolated pnpm workspace with its own frozen lockfile, so the seller install loop is required on a clean checkout. `npm run check` type-checks the root packages, verifies the public claim ledger, and builds and tests all four seller packages. The current gate contains 675 root tests, 20 category-parity tests, and 73 seller tests: 768 total. It covers API boundaries, byte-exact private seller-request preparation, retained paid-request replay through the production seller parsers, chain-read validation, commerce compatibility, durable state transitions, the four analyzers, category parity, seller delivery behavior with fixtures, and the closed live-rollout record.

The default run does not prove live data access, a funded purchase, delivery on chain, settlement, or performance. Environment-gated checks remain separate so a passing fixture suite cannot be mistaken for live evidence.

Persisted service requests preserve the exact generated task description and raw request bytes. Intake applies the hardened outbound endpoint policy, refuses genuinely new requests after the task deadline, and preserves exact retries and private reads. HealthGuard v1 uses base64url; RangePilot, GridQuant, and YieldScout may use bounded deflate-base64url so the final signed ERC-8183 description retains an 896-byte quote reserve. Reads validate the stored representation without requiring a compressor to reproduce identical compressed bytes. These records have no retention or crypto-erasure mechanism, so this boundary is for bounded testnet and demo inputs rather than production private portfolio data.

The focused request and quote boundary is reproduced with:

```sh
node --test \
  tests/contracts/service-request.test.ts \
  tests/contracts/service-quote.test.ts \
  tests/db/service-request-repository.test.ts \
  tests/db/verified-quote-repository.test.ts
```

All 80 deterministic tests cover closed request/task/snapshot binding, transport bounds, replay nonce, strict quote schemas, domain/token/price/time/hash/signer checks, canonical job-description generation, idempotency after expiry, buyer-private reads, tamper quarantine, and `fundingPermitted: false`. They use generated local EOA signatures and perform no RPC request, seller call, wallet action, funding, or chain write.

## Inspect the deployed read-only surfaces

API and database health are exposed at both `/health` and `/api/status`:

```sh
curl --fail --silent --show-error https://knot-api.truematchx.com/health
curl --fail --silent --show-error https://knot-api.truematchx.com/api/status
```

All four public seller cards, domain-registration proofs, and unauthenticated invocation boundaries:

```sh
npm run sellers:verify:public
```

These read-only checks establish point-in-time reachability and the published authentication and identity boundaries. They do not authenticate or request quotes. Private task, service-request, verified-quote, and job routes require API authorization; mutation routes additionally require the configured exact origin and idempotency key. The claim ledger records scoped evidence bindings rather than raw private credentials or a promise of current availability.

## Authenticated quote-only demo

The current repository contains an opt-in quote route and an operator runner:

```sh
KNOT_API_AUTH_TOKEN=<PRIVATE_API_TOKEN> \
KNOT_API_ALLOWED_ORIGIN=<CONFIGURED_HTTPS_ORIGIN> \
npm run demo:quote -- <UNIQUE_RUN_ID>
```

The runner creates a fresh private RangePilot analysis task from the retained, provenance-labeled fixture, persists its exact seller request, requests a verified quote, then requests the same quote again to prove immutable idempotency. It emits sanitized JSON to standard output. It contacts the KNOT API, RangePilot, and two pinned BSC testnet RPCs. It does not access a wallet, create a job, fund escrow, submit a transaction, or perform a mainnet write.

This command requires migrations `0011`–`0012`, the mode-`0600` owned-seller credential file, and explicit server-side enablement. Release `80e3b45` is deployed on the VPS and one sanitized authenticated RangePilot run is retained at [`evidence/operations/verified-quote-live-20260910.json`](evidence/operations/verified-quote-live-20260910.json). Verify its immutable release, migration hashes, HTTP results, database counts, identity agreement, idempotent retry, failed-closed incident, and zero-funding boundary with:

```sh
node --test tests/ops/verified-quote-live.test.ts
```

The offline test verifies the captured record; it does not repeat the private authenticated request, prove current availability, or extend the evidence to a paid hire, delivery, settlement, or independently operated seller.

## Probe network compatibility

```sh
npm run manifest:verify
```

This command reads the configured BSC networks, rewrites the tracked observations under `ops/manifests/network-56.json` and `ops/manifests/network-97.json`, and performs the live BSC testnet commerce compatibility check. It does not submit transactions. Inspect the resulting Git diff before retaining an observation. A write-enabled network exits unsuccessfully unless exactly one compatible live policy passes the configured checks.

Because this is a live read, results can change with RPC availability or contract state. Treat the generated manifest observations as time-bound evidence, not permanent guarantees.

## Verify preserved operational evidence

```sh
npm run reliability:verify
npm run availability:verify
npm run tunnel:verify -- evidence/operations/tunnel-recovery-20260909.json
npm run external-paid-job:verify
npm run external-paid-job:verify -- evidence/testnet/external-paid-job-1198.json
npm run external-paid-job:verify -- evidence/testnet/external-paid-job-1203.json
```

The first command verifies the bounded four-seller container-recovery drill. The second recomputes bounded captured-body hashes, replays identity-critical card and registration fields, and verifies five read-only samples for each seller across one approximately 60-second client-side window, including exact public paths, HTTP statuses, latency fields, cadence, publication bindings, and the no-auth, no-chain, no-mutation boundary. The third verifies the captured Cloudflare tunnel service restart, unchanged seller containers, and complete public recovery. The last three commands validate the preserved job `1191`, `1198`, and `1203` records' schemas, hashes, bindings, lifecycle ordering, refund arithmetic, canonical KNOT seller set, observed discovery consistency or mismatches, and explicit limitations. Job `1203` also recovers its EIP-191 quote signer offline. These job verifiers are internal-consistency checks and do not by themselves prove that recorded receipts or events exist on chain; the first two ERC-1271 results remain capture-time evidence.

Public BSC testnet reads can independently verify the seven transaction receipts and target contracts, relevant lifecycle events, exact refund transfer, current ERC-8004 owner, payment token, cleared router policy, and current terminal job state:

```sh
npm run external-paid-job:verify:live
npm run external-paid-job:verify:live -- evidence/testnet/external-paid-job-1198.json
npm run external-paid-job:verify:live -- evidence/testnet/external-paid-job-1203.json
```

The live commands perform no chain writes and need no wallet. They do not repeat historical ERC-1271 checks. Job `1191` records that its acceptance-block state was already pruned when captured; job `1198` preserves a successful funding-block check from its capture, but that point-in-time result may stop being reproducible as public RPC history is pruned. Job `1203` uses EIP-191, so its signer is recovered offline without historical chain state. None establishes uptime, an SLA, regional behavior, a successful external hire, operator independence, mainnet readiness, or real-money use.

## Capture a controlled tunnel restart

The published record can be verified without SSH by using the command above. Repeating the operator action requires SSH key authentication in batch mode and refuses to run without both an explicit execution flag and a plain SSH destination. Its only remote mutation is `systemctl restart cloudflared`; it does not restart the VPS, Docker daemon, database, object store, or any KNOT container, and it performs no authenticated seller request or chain call.

```sh
KNOT_RELIABILITY_SSH_HOST=<SSH_DESTINATION> npm run tunnel:drill -- --execute
npm run tunnel:verify -- .secrets/reliability/tunnel-recovery-latest.json
```

The excluded private output is the default. The published record measured `12,832 ms` from restart request to complete public recovery in one attempt within its `120,000 ms` bound. It records the systemd active/enabled/restart state, a new service invocation, unchanged seller image IDs and start times, API/database health, four identity-bearing seller cards and registration proofs, four fail-closed unauthenticated requests, and one retained artifact hash. This single successful record does not establish uptime, an SLA, failover, host recovery, load capacity, or regional availability.

## Optional BSC mainnet read

Provide a trusted BSC mainnet RPC endpoint, then run the isolated read-only test:

```sh
KNOT_LIVE_VENUS_RPC=<BSC_MAINNET_RPC_URL> npm run test:live:venus
```

This checks the configured Venus Core market inventory at a confirmed BSC block. It performs no writes and is not part of the default fixture result.

## Optional PostgreSQL integration

Point `KNOT_TEST_DATABASE_URL` at a disposable PostgreSQL database, then run:

```sh
KNOT_TEST_DATABASE_URL=<DISPOSABLE_POSTGRES_URL> npm run test:integration:postgres
```

The core command runs 17 PostgreSQL integration tests. Three additional integration files cover the identity vault, owned-seller promotion, and verified-quote orchestration:

```sh
KNOT_TEST_DATABASE_URL=<FRESH_DISPOSABLE_POSTGRES_URL> node --test tests/db/erc8004-identity-observation-repository.integration.ts
KNOT_TEST_DATABASE_URL=<FRESH_DISPOSABLE_POSTGRES_URL> node --test tests/db/owned-seller-agent-repository.integration.ts
KNOT_TEST_DATABASE_URL=<FRESH_DISPOSABLE_POSTGRES_URL> node --test tests/api/verified-quote-persistence.integration.ts
```

Run each command against a fresh disposable database. Together the four suites contain 23 tests: 17 core persistence, 1 identity-vault, 1 transactional owned-seller promotion, and 4 quote-orchestration cases. They cover exact request bytes, migrations, hashes, task and identity binding, deadlines, idempotency, atomic endpoint/identity/quote persistence, concurrent negotiation collapse, signature-failure rollback, immutable expired retries, zero jobs/outbox/chain actions, action authority, canonical transaction intents, leases, recovery rotation, and legacy quarantine. They use generated local EOA signatures and do not contact a seller, use RPC or a wallet, fund a job, deploy, or enable the recovery worker.

The fixture-only observer and worker wiring checks are read-only and contain no wallet or broadcast path:

```sh
node --test tests/chain/transaction-intent.test.ts tests/worker/bsc-chain-receipt-observer.test.ts tests/worker/chain-action-reconciler.test.ts tests/worker/chain-action-recovery-worker.test.ts tests/worker/worker-config.test.ts tests/worker/worker-runtime.test.ts
```

These 36 tests verify canonical intent commitments, exact transaction/receipt/block binding, confirmation calculation, reorg and malformed-response refusal, shutdown abort propagation without an outcome rewrite, exact fenced-lease release, disabled-by-default configuration, and one bounded recovery scan per worker cycle. They do not prove a deployed observation. The implemented observer supports only already-journaled transaction hashes for direct-EOA legacy transactions; hashless outcomes remain fenced as `UNKNOWN`.

The sanitized deployed rollout and one-shot read-only receipt observation have a closed offline verifier:

```sh
npm run chain-recovery-rollout:verify
```

The offline verifier binds the sanitized release, immutable image, service starts, mode-`0600` worker-only gate, seven migrations, empty database and worker samples, five HTTP-200 checks, the one-shot job-1203 receipt observation, and every zero-write limitation. It does not repeat the deployment or RPC call and therefore verifies the captured record rather than proving uptime or queued recovery effectiveness.

That seven-migration count belongs to the retained rollout; the current source tree contains 12 migrations.

The deployment contract keeps the observer configuration in a mode-`0600` environment mounted only into the worker and rejects unsafe RPC locations or out-of-range recovery controls:

```sh
node --test tests/ops/backend-deployment-config.test.ts
```

## Test logical backup and restore safety

```sh
npm run test:backend-snapshot
npm run test:backend-active-recovery
```

The snapshot suite uses command stubs and temporary directories; it does not contact or modify a deployed environment. It verifies private file modes, fail-if-present staging, a deployment-wide nonblocking maintenance lock, completion and release manifests, database counts, separate inventories for both object buckets, API, worker, and four seller-writer quiescing, refusal when either the current or restored database contains active jobs or chain actions, shadow validation and cleanup, cutover readback, writer health checks, and automatic two-bucket rollback after an injected cutover failure. The active-recovery drill uses disposable PostgreSQL, proves backup refuses a queued `PREPARED` action before `pg_dump`, leaves the action byte-for-byte intact, clears the maintenance lock, and restarts every writer through command stubs.

The operator scripts capture only a quiesced logical PostgreSQL dump plus current `knot-artifacts` and purchased `knot-deliverables` object bytes. They exclude PostgreSQL physical files and WAL, prior object versions and bucket metadata, in-flight requests, host configuration, secrets, and external chain state. A backup requires digest-pinned references and immutable image IDs for the shared API/worker release and each of the four seller containers. A restore additionally requires exact git, lockfile, migration, Compose, network-manifest, and all five deployed-image bindings. It refuses rather than reconciling active work. The completion marker is a co-located integrity checksum, not an authenticity signature. No production restore, deployed active-action recovery, RPO, RTO, or repeated recovery measurement is claimed by this fixture test.

An uncertain rollback, rollback readback, writer restart, or writer health result leaves the deployment-wide lock in a persistent `FAILED` state. Subsequent backup and restore attempts refuse it. After manually establishing the deployment state, an operator must supply the exact failure identifier and original absolute operation target recorded by the interlock:

```sh
npm run maintenance:acknowledge -- <ABSOLUTE_LOCK_DIRECTORY> <FAILURE_ID> <ABSOLUTE_OPERATION_TARGET> --confirm-clear
```

The acknowledgement clears only that exact target-bound failure record; it does not repair, roll back, restart, or validate the deployment.

## Evidence interpretation

The statuses and evidence classes used by the public evidence set are defined inside [`evidence/claims.json`](evidence/claims.json). In particular:

- `SUPPORTED` means the listed evidence supports the claim within its stated scope;
- `PARTIAL` means some, but not all, of the claim is supported;
- `UNMEASURED` means the necessary measurement has not been published;
- `NOT_CLAIMED` keeps an unproven capability outside the submission claim set.

Evidence classes distinguish time-bound mainnet or testnet observations from deterministic fixtures and operator-reported service status.
