# GridQuant seller

The A2A seller exposes deterministic `negotiate` and `notify_funded` operations. `negotiate` clamps and signs the configured 0.1 U list price without model involvement. `notify_funded` verifies the signed BSC testnet job, analyzes its pinned BSC mainnet snapshot, stores the typed artifact, and submits its manifest on-chain.

`src/gridQuant.ts` accepts only `knot.gridquant.request/2`, the allowlisted WBNB/USDT PancakeSwap v3 pool, confirmed fresh snapshots, internally consistent gas evidence, explicit analysis authority, and analysis capability. Unsupported identity, pool, token, decimal, permission, freshness, gas, capital, inventory, fee, and execution conditions fail closed.

The versioned base64url transport protects signed JSON from ERC-8183 claim sanitization. Plain JSON remains accepted for direct callers.

The runtime contains no trading tool. Signing remains fixed inside `src/signing.ts`, and the encrypted keystore remains outside this directory.
