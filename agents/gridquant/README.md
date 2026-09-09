# GridQuant

GridQuant is KNOT's analysis-only grid seller for the allowlisted WBNB/USDT PancakeSwap v3 pool on BSC mainnet. It accepts signed, pinned evidence and returns a closed-schema plan, no-action result, or explicit refusal. It never signs orders, swaps, or liquidity transactions.

The seller uses ERC-8183 on BSC testnet for quotes, funding, submission, and settlement. The fixed quote path and on-chain submission path remain separate from deterministic analysis.

Run from this directory:

```bash
pnpm --dir app/agent build
pnpm --dir app/agent test
bag doctor
```

The encrypted signer must remain under `.studio/wallets/`, outside the deployed `app/agent/` package. Durable storage, a dedicated wallet, and the selected hosting provider are required before deployment.
