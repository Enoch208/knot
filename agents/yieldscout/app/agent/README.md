# YieldScout seller

The A2A seller exposes deterministic `negotiate` and `notify_funded` operations. `negotiate` clamps and signs the configured 0.1 U list price without model involvement. `notify_funded` verifies the signed BSC testnet job, analyzes its pinned BSC mainnet evidence, stores the typed artifact, and submits its manifest on-chain.

`src/yieldScout.ts` accepts only `knot.yield.request/2`, configured integration and protocol identities, a single plain asset, confirmed fresh block evidence, explicit gross-rate basis and sources, explicit incentive status and valuation sources, current cost valuation, known liquidity and capacity, bounded concentration, inactive risk flags, and analysis authority. Unknown required inputs fail closed.

Outputs are simple annualized rate projections. They are not APY, TVL, historical performance, or promised returns. The runtime contains no capital execution tool.

The versioned base64url transport protects signed JSON from ERC-8183 claim sanitization. Signing remains fixed inside `src/signing.ts`, and the encrypted keystore remains outside this directory.
