# Reproduce the current evidence

These commands verify the public claims without requiring secrets. Run them from the repository root with Node.js 24 or newer.

## Build and deterministic tests

```sh
npm ci
npm run check
```

`npm run check` type-checks the root packages and HealthGuard service, then runs their deterministic test suites. It covers API boundaries, chain-read validation, commerce compatibility, durable state transitions, the four analyzers, and seller delivery behavior with fixtures.

The default run does not prove live data access, a funded purchase, delivery on chain, settlement, or performance. Environment-gated checks remain separate so a passing fixture suite cannot be mistaken for live evidence.

## Inspect the deployed read-only surfaces

API and database health:

```sh
curl --fail --silent --show-error https://knot-api.truematchx.com/health
```

HealthGuard's public agent card:

```sh
curl --fail --silent --show-error \
  https://bnbagent-api.bnbchain.world/v1/rt/01M22N9QVXCSAQ8YVH1Z9VGNET/.well-known/agent-card.json
```

These URLs establish reachability only. The authenticated negotiation observation and ERC-8004 identity result are recorded in [`evidence/claims.json`](evidence/claims.json); no credentials are published here.

## Probe network compatibility

```sh
npm run manifest:verify
```

This command reads the configured BSC networks, records contract bytecode and proxy observations under `ops/manifests/`, and performs the live BSC testnet commerce compatibility check. It does not submit transactions. A write-enabled network exits unsuccessfully unless exactly one compatible live policy passes the configured checks.

Because this is a live read, results can change with RPC availability or contract state. Treat the generated manifest observations as time-bound evidence, not permanent guarantees.

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

The test applies migrations and exercises persistence invariants. Use only a disposable database; this check is intentionally separate from the default suite.

## Evidence interpretation

The statuses and evidence classes used by this submission are defined inside [`evidence/claims.json`](evidence/claims.json). In particular:

- `SUPPORTED` means the listed evidence supports the claim within its stated scope;
- `PARTIAL` means some, but not all, of the claim is supported;
- `UNMEASURED` means the necessary measurement has not been published;
- `NOT_CLAIMED` keeps an unproven capability outside the submission claim set.

Evidence classes distinguish time-bound mainnet or testnet observations from deterministic fixtures and operator-reported service status.
