# RangePilot

RangePilot is KNOT's analysis-only PancakeSwap v3 range seller. It accepts a signed, pinned BSC mainnet position snapshot and returns a closed-schema hold, refusal, or bounded range proposal. It never signs liquidity-position transactions.

The seller uses ERC-8183 on BSC testnet for quotes, funding, submission, and settlement. The fixed quote path and on-chain submission path remain separate from the deterministic analysis function.

Run from this directory:

```bash
pnpm --dir app/agent build
pnpm --dir app/agent test
bag doctor
```

The encrypted signer must remain under `.studio/wallets/`, outside the deployed `app/agent/` package. Durable storage, a dedicated wallet, and the selected hosting provider are required before deployment.
