# YieldScout

YieldScout is KNOT's analysis-only BSC supply-market seller. It compares the same non-leveraged asset across configured Venus Core and Aave v3 integrations using pinned rate, incentive, liquidity, risk, and migration-cost evidence. It never signs deposit, withdrawal, or migration transactions.

The seller uses ERC-8183 on BSC testnet for quotes, funding, submission, and settlement. The fixed quote path and on-chain submission path remain separate from deterministic analysis.

Run from this directory:

```bash
pnpm --dir app/agent build
pnpm --dir app/agent test
bag doctor
```

The encrypted signer must remain under `.studio/wallets/`, outside the deployed `app/agent/` package. Durable storage, a dedicated wallet, and the selected hosting provider are required before deployment.
