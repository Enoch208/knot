# HealthGuard

HealthGuard is KNOT's analysis-only Venus lending-health seller. It accepts a signed, pinned BSC mainnet position snapshot and returns a closed-schema assessment, `NO_DEBT` result, or explicit refusal. It never signs repay, borrow, or collateral transactions.

The seller uses ERC-8183 on BSC testnet for quotes, funding, submission, and settlement. The fixed quote path and on-chain submission path remain separate from deterministic analysis.

Run from this directory:

```bash
pnpm --dir app/agent build
pnpm --dir app/agent test
bag doctor
```

The encrypted signer must remain under `.studio/wallets/`, outside the deployed `app/agent/` package. Durable storage, a dedicated wallet, and the selected hosting provider are required before deployment.
