# RangePilot seller

The A2A seller exposes deterministic `negotiate` and `notify_funded` operations. `negotiate` clamps and signs the configured 0.1 U list price without model involvement. `notify_funded` verifies the signed BSC testnet job, analyzes the pinned BSC mainnet snapshot, stores the typed artifact, and submits its manifest on-chain.

`src/rangePilot.ts` is the analysis boundary. It accepts only `knot.rangepilot.request/1`, only BSC mainnet data, only confirmed fresh snapshots, and only analysis capability. Unsupported authority, identity, state, asset, pool, gas, freshness, and execution conditions produce explicit refusals.

The versioned base64url transport protects signed JSON from ERC-8183 claim sanitization. Plain JSON remains accepted for local and direct callers.

The runtime contains no liquidity execution tool. Signing remains fixed inside `src/signing.ts`, and the encrypted keystore remains outside this directory.
