# Threat model

This document states what KNOT protects, where its trust boundaries are, which adversaries the code currently refuses, and — in the final section — what it does **not** defend against. Every enforcement row names the file that performs the check. Every capability sentence names the network it applies to.

Scope of the deployed system at the time of writing:

| Purpose | Network | Writes |
| --- | --- | --- |
| Financial input data (Venus, PancakeSwap v3, Aave v3 reads) | BSC mainnet (`56`) | None. `ops/manifests/network-56.json` records `writesPermitted: false`, and `packages/chain/src/manifest.ts` sets `MAINNET.writeEnabled = false` |
| Agent identity (ERC-8004) | BSC testnet (`97`) | Registration and bounded identity operations |
| Service payment (ERC-8183 commerce) | BSC testnet (`97`) | Test-token jobs only, in test `U` (`0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`) |
| Domain execution (swaps, liquidity, lending) | None | Disabled. No analyzer signs a domain transaction |

No file under `packages/`, `apps/` or `scripts/` constructs a wallet client, signs a transaction, or broadcasts one. `createWalletClient`, `privateKeyToAccount`, `writeContract`, `sendTransaction` and `sendRawTransaction` appear only in test fixtures that generate local EOA signatures. The deployed secret inventory in `ops/backend/secrets.schema.json` contains no keystore, mnemonic or private key for the API or worker.

## Assets

| Asset | Where it lives | Worst realistic loss |
| --- | --- | --- |
| Buyer escrow funds | ERC-8183 commerce escrow on BSC testnet `97`, denominated in test `U` | Test-token loss only. No mainnet funds have ever been at risk, because no mainnet write path exists |
| Buyer gas balance | Buyer EOA `0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930` on BSC testnet `97` | Testnet `tBNB`. Never reported as dollars |
| Session authority | `sessions` rows (`packages/db/migrations/0001_domain.sql`) plus the on-chain key-store grant recorded in `evidence/testnet/bounded-authority-grant-revoke.json` | A session widened beyond its allowlisted call could move value. The grant/revoke observation shows the narrow case working on `97` only |
| Seller signing keys | Inside each seller container, loaded by `@bnbagent/studio-runtime/wallet` `getWallet()` from a local keystore unlocked by `WALLET_PASSWORD` (`agents/<seller>/app/agent/src/signing.ts`) | A compromised seller container can sign quotes, submit deliverables and claim settlement on `97` |
| Seller OAuth client secrets | `/etc/knot/owned-sellers.env`, mode `0600` (`ops/backend/secrets.schema.json`) | Authenticated invocation of a KNOT seller |
| API bearer token and buyer binding | `/etc/knot/api.env`, mode `0600` | Full access to every private task, service request, quote and job of the single configured buyer |
| Evidence integrity | `evidence/claims.json`, `evidence/testnet/*`, `evidence/operations/*`, `ops/manifests/*`, plus append-only PostgreSQL tables | A falsified claim is the most damaging failure in this product, because the product is an evidence claim |
| Deliverable artifacts | Object store, served at `https://knot-artifacts.truematchx.com/knot-deliverables/...` | Already public; see `PRIVACY.md` |

## Trust boundaries

| # | Boundary | Crossing | Trust assumption |
| --- | --- | --- | --- |
| B1 | Browser to web app | HTTPS to the Next.js surface (`apps/web`) | The published web surface is a read-only public projection. It holds no credential and performs no mutation |
| B2 | Operator client to KNOT API | HTTPS through a Cloudflare tunnel to `127.0.0.1:8787` (`apps/api/src/server.ts`, `ops/backend/cloudflared-ingress.fragment.yaml`) | Bearer token plus exact `Origin` on mutations. One token, one buyer address |
| B3 | API to seller runtime | OAuth client-credentials then one bounded A2A `message/send` (`packages/security/src/owned-seller-client.ts`) | The seller is untrusted. Its response must satisfy a closed schema and a cryptographic quote verification |
| B4 | API and worker to RPC providers | `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionReceipt` | Providers are untrusted for content and trusted for liveness. Identity reads require two providers to agree |
| B5 | API and scripts to arbitrary public hosts | `safeFetch` (`packages/security/src/safe-fetch.ts`, `packages/security/src/address-policy.ts`) | Any hostname may be hostile or resolve into the host network |
| B6 | Discovery to the 8004scan index and ERC-8004 registry metadata | `packages/discovery/src/scan-client.ts`, `packages/discovery/src/normalize.ts` | Index and publisher metadata are untrusted claims, never facts |
| B7 | Seller runtime to chain | The seller signs and broadcasts `submit` and `settle` itself (`agents/<seller>/app/agent/src/signing.ts`) | The seller is the sole key-holder for its own agent. KNOT's backend cannot sign on its behalf, and cannot stop it |
| B8 | Worker to journalled chain state | Read-only receipt observation (`apps/worker/src/bsc-chain-receipt-observer.ts`) | Observation may be unavailable, stale, reorganised or mismatched. None of those is a success or a failure |
| B9 | Operator to host | SSH in batch mode, only for the tunnel drill, whose single remote mutation is `systemctl restart cloudflared` | The operator is trusted. This is not a multi-tenant system |

## Adversaries considered, and what refuses them

### A1. Malicious or buggy seller

| Attack | Enforcement | File |
| --- | --- | --- |
| Return a quote for a different task, price or currency | `verifyOwnedSellerQuote` requires the quoted request to equal the exact normalised sent request, the `chain_id` to be `97`, `verifying_contract` to equal the expected commerce address, and the currency to match; failures raise `REQUEST_BINDING_MISMATCH` or `DOMAIN_MISMATCH` | `packages/contracts/src/service-quote.ts` |
| Quietly rewrite deliverables or quality standards in the response | Response terms must equal the sent terms field by field | `packages/contracts/src/service-quote.ts` |
| Overcharge | `price <= expected.maxPriceUnits`, else `PRICE_INVALID` | `packages/contracts/src/service-quote.ts` |
| Sign with a key that is not the registered owner | EIP-191 recovery must equal the owner observed on chain, else `SIGNER_MISMATCH` | `packages/contracts/src/service-quote.ts` |
| Smuggle instructions or fetchable URLs into the negotiation | `context_urls` on either the sent request or the quote is refused with `CONTEXT_URLS_FORBIDDEN`; task description and all terms must survive the SDK `sanitizeForClaim` transform unchanged, else `SANITIZATION_MISMATCH` | `packages/contracts/src/service-quote.ts` |
| Answer a different request than the one sent | The JSON-RPC `id` in the response must equal the request id, else `SELLER_RESPONSE_INVALID` | `packages/security/src/owned-seller-client.ts` |
| Flood the caller with a huge body | OAuth responses capped at 16,384 bytes, invocation requests at 16,384 bytes, invocation responses at 131,072 bytes | `packages/security/src/owned-seller-client.ts` |
| Redirect the authenticated call elsewhere | Both seller calls set `maxRedirects: 0` | `packages/security/src/owned-seller-client.ts` |
| Accept funding and deliver nothing | Work state and money state are separate records, and escrow returns by refund after expiry. Three recorded external cases: jobs `1191`, `1198`, `1203`, each `EXPIRED_WITHOUT_DELIVERY` with `providerPaymentBaseUnits: "0"` and the exact escrow refunded | `packages/db/src/state-machine.ts`, `evidence/testnet/external-paid-job-{1191,1198,1203}.json` |
| Deliver a hash-matched artifact that refuses the request | Recorded, not hidden. Job `1180` submitted an `INVALID_REQUEST`/`INVALID_JSON` artifact after a `@bnbagent/sdk 0.5.5` description-encoding change; the buyer disputed and recovered the full 0.1 `U` escrow through `claimRefund` after expiry, and the job is explicitly not counted as a delivery | `evidence/testnet/healthguard-job-1180.json`, `evidence/claims.json` |

### A2. Compromised or lying RPC provider

| Attack | Enforcement | File |
| --- | --- | --- |
| Report a false ERC-8004 owner | Identity is read from two pinned BSC testnet providers; any disagreement on owner, agent wallet or token URI raises `RPC_DISAGREEMENT` | `packages/chain/src/erc8004-identity.ts` |
| Serve an unconfirmed or re-organised block | Reads target `minimumHead - 3`; the block hash is re-read after the identity reads and a change raises `ORPHANED_OBSERVATION` | `packages/chain/src/erc8004-identity.ts` |
| Serve stale state | A block older than 30 seconds raises `STALE_BLOCK`; a future timestamp beyond 5 seconds raises `UPSTREAM_UNAVAILABLE` | `packages/chain/src/erc8004-identity.ts` |
| Point the client at the wrong chain | Every reader must report chain `97`, else `CONFIGURATION_MISMATCH`; the commerce probe refuses a chain other than `97` and refuses an RPC behind pinned block `129987120` | `packages/chain/src/erc8004-identity.ts`, `packages/commerce/src/compatibility.ts` |
| Substitute a contract-controlled owner for an EOA | The owner address must have no code at the observed block, else `IDENTITY_MISMATCH` | `packages/chain/src/erc8004-identity.ts` |
| Persist a contradictory observation | Database triggers refuse a second observation at the same chain and block with a different block hash, registry deployment or agent state, and the table is append-only | `packages/db/migrations/0011_erc8004_identity_observations.sql` |
| Report fewer than two agreeing providers | The stored `rpc_agreement` envelope requires `providerCount >= 2` and `agreementCount = providerCount` | `packages/db/migrations/0011_erc8004_identity_observations.sql` |

### A3. Replayed or stale quote

| Attack | Enforcement | File |
| --- | --- | --- |
| Reuse a quote issued for an earlier request | The immutable service-request id is the replay nonce; `sentRequest.request_id` must equal the expected nonce, else `REQUEST_BINDING_MISMATCH` | `packages/contracts/src/service-quote.ts` |
| Present a long-lived quote | Quote TTL must be between 1 and 900 seconds; the quote must not be expired; negotiation time may not exceed now by more than the skew bound (default 30 s, maximum 300 s) | `packages/contracts/src/service-quote.ts` |
| Replay a quote across chains or contracts | The signed envelope binds `chain_id` and `verifying_contract`, and the database enforces `UNIQUE (chain_id, commerce, negotiation_hash)` | `packages/contracts/src/service-quote.ts`, `packages/db/migrations/0010_verified_quotes.sql` |
| Mutate a stored quote after the fact | `verified_quotes` rejects `UPDATE`, `DELETE` and `TRUNCATE`; an exact retry returns the stored row without re-contacting the seller or any RPC | `packages/db/migrations/0010_verified_quotes.sql` |
| Fund past the task deadline | The insert guard refuses a quote whose expiry exceeds the task deadline or whose deadline has already elapsed; intake refuses a genuinely new service request after the deadline | `packages/db/migrations/0010_verified_quotes.sql`, `apps/api/src/app.ts` |
| Fund a quote whose dispute window leaves no room | `prepareHire` refuses unless `expiredAt > now + disputeWindowSeconds` for the selected policy, which is 900 seconds for the live testnet policy | `packages/commerce/src/hire.ts` |

Three earlier paid jobs — GridQuant `1187`, YieldScout `1188`, RangePilot `1189` — predate mandatory request-id replay binding and are intentionally rejected by the current verifier. That is recorded in `evidence/claims.json` rather than grandfathered.

### A4. Hostile registry or index metadata

| Attack | Enforcement | File |
| --- | --- | --- |
| Publish a misleading name, description or protocol list | Every such field is wrapped as a provenance-labelled `claimed(...)` value sourced to `erc-8004 registry metadata`, never promoted to a fact | `packages/discovery/src/normalize.ts`, `packages/provenance/src/provenance.ts` |
| Inject unexpected fields into an index row | Unknown keys are collected into a frozen `untrustedMetadata` object and excluded from every typed field | `packages/discovery/src/normalize.ts` |
| Claim a chain outside the declared manifest | `UnsupportedRegistryChainError` for any chain other than `56` or `97` | `packages/discovery/src/normalize.ts` |
| Fabricate a reputation score | `averageScore` is `unavailable` whenever feedback count is zero; a null index value can never carry a number | `packages/discovery/src/normalize.ts` |
| Impersonate a KNOT seller | The four sellers are an allowlist of origin, card name, OAuth scope, registry, agent id and owner. The verifier additionally requires the card URL to equal its own HTTPS origin, the OAuth token URL to be same-origin, the `negotiate` and `notify_funded` skills to be present, the scope to be bound in `security`, and the domain-registration proof to bind exactly `eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e` with the expected agent id | `packages/discovery/src/public-sellers.ts` |
| Redirect an owned-seller call to a different host | The client refuses any descriptor whose token URL is not `${origin}/oauth/token` or whose invocation URL is not `${origin}/`, and `resolveOwnedSellerAuthority` requires the stored endpoint to equal the expected origin exactly | `packages/security/src/owned-seller-client.ts`, `packages/discovery/src/public-sellers.ts` |

Index disagreement is published rather than smoothed over: 8004scan discovered agents `2297`, `2298` and `2299` but reported `is_verified=false` even though each standard domain-registration proof returned HTTP 200. That limitation is recorded against all three seller claims in `evidence/claims.json`.

### A5. Stale or swapped proxy implementation

| Attack | Enforcement | File |
| --- | --- | --- |
| Upgrade the commerce, router or registry proxy behind us | Every write-readiness probe compares the proxy code hash, the ERC-1967 implementation address read from slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, and the implementation code hash against the pinned snapshot at block `129987120`; any mismatch is a refusal reason and `writeAllowed` becomes `false` | `packages/commerce/src/compatibility.ts`, `packages/commerce/src/deployments.ts` |
| Rebind the router to a different commerce kernel, or pause it | `routerCommerce` must equal the expected commerce address and `routerPaused` must be false | `packages/commerce/src/compatibility.ts` |
| Change the escrow payment token | `paymentToken` read from commerce must equal the SDK deployment token | `packages/commerce/src/compatibility.ts` |
| Swap the ERC-8004 registry implementation between identity reads | Each identity read re-checks the registry proxy code hash, the implementation slot and the implementation code hash against the pin, raising `DEPLOYMENT_MISMATCH` | `packages/chain/src/erc8004-identity.ts` |
| Let bytecode drift unnoticed across observations | `verify-manifest` diffs each role's code hash and implementation code hash against the previously retained manifest and records drift as a suspension; a write-enabled network with any suspension exits non-zero | `scripts/verify-manifest.ts` |
| Proceed anyway | `requireCommerceWriteReady` throws `ERC-8183 writes are suspended: <reasons>`. There is no override flag | `packages/commerce/src/compatibility.ts` |

Observed at chain `97` block `130057527`, both `commerce` and `router` are 130-byte proxy stubs whose ERC-1967 admin slot reads zero, so `proxyAdmin` is recorded as `null` in `ops/manifests/network-97.json`. The same is true on chain `56` at block `120912693`. A null admin slot is recorded as an observation; it is not interpreted as a guarantee about who can upgrade these contracts.

### A6. Server-side request forgery and egress abuse

| Attack | Refusal code | File |
| --- | --- | --- |
| Target a cloud metadata endpoint or loopback by IP literal | `NON_PUBLIC_ADDRESS` | `packages/security/src/address-policy.ts` |
| Resolve a public hostname to a mixed public and private address set | `NON_PUBLIC_ADDRESS` — the whole resolution set is rejected, not filtered | `packages/security/src/address-policy.ts` |
| Use `localhost`, `.local`, `.internal`, `.home.arpa`, `.onion` or a single-label host | `PRIVATE_HOSTNAME` | `packages/security/src/address-policy.ts` |
| Downgrade to HTTP, use a non-443 port, or embed credentials in the URL | `HTTPS_REQUIRED`, `UNSAFE_PORT`, `EMBEDDED_CREDENTIALS` | `packages/security/src/address-policy.ts` |
| Redirect into the host network | Each hop is re-validated and re-resolved; `NON_PUBLIC_ADDRESS`, `UNSAFE_REDIRECT`, `REDIRECT_LIMIT` or `REDIRECT_WITHOUT_LOCATION` | `packages/security/src/safe-fetch.ts` |
| Steal an `Authorization` or `X-Api-Key` header by redirecting cross-origin | `UNSAFE_REDIRECT` | `packages/security/src/safe-fetch.ts` |
| Smuggle a header or inject CRLF | `UNSAFE_HEADER`. Only `accept`, `authorization`, `content-type`, `user-agent` and `x-api-key` are permitted; values are capped at 8,192 bytes and may not contain CR or LF | `packages/security/src/safe-fetch.ts` |
| Exhaust memory or hang the caller | `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `UPSTREAM_TIMEOUT`. One total wall-clock deadline spans DNS resolution, every redirect and the response transfer | `packages/security/src/safe-fetch.ts` |

DNS resolution and TLS connection are separated: `resolvePublicAddresses` validates every resolved address, and `nodeHttpsTransport` connects to the accepted address with `servername` set to the original hostname, so the address checked is the address used. Seven frozen adversarial cases are retained in `evidence/security/safe-fetch-cases.json`.

### A7. State corruption, concurrency and unknown outcomes

| Attack or hazard | Enforcement | File |
| --- | --- | --- |
| Treat a delivered artifact as a settled payment | Work state and money state are separate machines over separate columns | `packages/db/src/state-machine.ts`, `packages/db/migrations/0001_domain.sql` |
| Collapse an unknown broadcast into success or failure | `UNKNOWN` is a real state. A `PREPARED` action with no observation becomes `UNKNOWN` rather than `FAILED`; a `SUBMITTED` action with an unavailable, invalid or mismatched receipt becomes `UNKNOWN`; only a valid, binding-matched receipt with enough confirmations becomes `CONFIRMED` or `FAILED` | `apps/worker/src/chain-action-reconciler.ts` |
| Resubmit a transaction that may already be mined | No broadcaster exists. `actionTransitions` permits `UNKNOWN -> CONFIRMED` and `UNKNOWN -> FAILED` only; there is no `UNKNOWN -> SUBMITTED` edge | `packages/db/src/state-machine.ts` |
| Accept a receipt for a different transaction | The observation must match chain id, transaction-intent hash, signer address, nonce and, when known, transaction hash | `apps/worker/src/chain-action-reconciler.ts` |
| Two workers act on one job | Fenced job leases with `FOR UPDATE SKIP LOCKED` and a fencing token; an expired or fenced lease raises `LeaseRejectedError`; the reconciler refuses to start with under 1,000 ms of lease margin | `packages/db/src/job-repository.ts`, `packages/db/src/errors.ts`, `apps/worker/src/chain-action-reconciler.ts` |
| Rewrite an outcome during shutdown | An aborted observation propagates instead of writing a state | `apps/worker/src/chain-action-reconciler.ts` |
| Reuse one nonce for two actions | Partial unique index on `(chain_id, signer_address, nonce)` | `packages/db/migrations/0001_domain.sql` |
| Sign a chain action outside its session grant | `requireChainActionAuthority` locks the session row and requires the job buyer, task buyer and session owner to be the same address, the session to be unexpired and unrevoked, the chain to match, and an allowlisted permission to match the task id, action sequence, semantic action, signer, account, chain, nonce, relay intent and request hash exactly | `packages/db/src/chain-action-authority.ts` |
| Retry a mutation with a different body | `Idempotency-Key` must equal the immutable resource identifier, and a reused key bound to different intent returns `409 CONFLICT` | `apps/api/src/app.ts`, `packages/db/src/errors.ts` |
| Leak an internal failure as a financial claim | Every API error carries an explicit `SafeFinancialState` of `unfunded`, `funded_unsettled`, `settled`, `refunded` or `unknown`; the default is `unknown`, never `settled` | `apps/api/src/errors.ts` |
| Quietly reinterpret absent data | Analyzers return `UNSUPPORTED_POSITION`, `STALE_SNAPSHOT`, `RESULT_INCOMPLETE` or a category-specific refusal; no-debt is `NO_DEBT`, not a perfect score | `packages/contracts/src/task.ts`, `packages/services/*` |

### A8. Unauthorised access to private records

| Attack | Enforcement | File |
| --- | --- | --- |
| Read another record without authorisation | Every private route requires `Authorization: Bearer`, compared with `timingSafeEqual` over SHA-256 digests so length does not leak; the token must be at least 32 characters | `apps/api/src/app.ts`, `apps/api/src/config.ts` |
| Drive a mutation from a foreign page | Mutations and `OPTIONS` require `Origin` to equal `KNOT_API_ALLOWED_ORIGIN` exactly, which must itself be a bare origin with no path | `apps/api/src/app.ts`, `apps/api/src/config.ts` |
| Read a record belonging to a different buyer | Every read is scoped by the configured buyer address | `apps/api/src/app.ts` |
| Send an oversized or non-JSON body | `Content-Type` must start with `application/json`; bodies over `KNOT_API_MAX_BODY_BYTES` (default 131,072) return `413` | `apps/api/src/app.ts`, `apps/api/src/server.ts` |
| Hold a database connection open | `connectionTimeoutMillis: 5000` and `statement_timeout: 10000` | `apps/api/src/server.ts` |
| Reuse the API token as a seller secret | Startup refuses when any seller client secret equals `KNOT_API_AUTH_TOKEN`, or when two seller secrets are identical | `apps/api/src/owned-seller-config.ts` |
| Enable owned-seller egress by accident | `KNOT_OWNED_SELLER_NEGOTIATION_ENABLED` must be the literal `true`; anything other than `true` or `false` throws | `apps/api/src/owned-seller-config.ts` |
| Overwhelm a seller | Each seller enforces a process-wide sliding window, 120 requests per 60 seconds by default, plus an optional per-caller bucket of 20 that is enabled only when the operator names a header its trusted edge sets. Request payload fields and forwarded IP headers are never treated as identities | `agents/<seller>/app/agent/src/requestLimits.ts` |

## Fail-closed posture

There is no flag that converts a refusal into a proceed. The write gate is a single function, `requireCommerceWriteReady`, which throws unless `status === "VERIFIED"`, `writeAllowed === true` and a selected policy exists. `verifyTestnetCommerce` wraps its own probe so that an exception becomes `status: "UNRESOLVED"`, `writeAllowed: false`, `declarationConflict: true` — an error never degrades into permission.

## Not defended against

This section is the load-bearing part of this document. Each item is a real, currently unmitigated gap.

### Fund safety on BSC mainnet is untested, because it has never been exercised

No mainnet write path exists. `verifyTestnetCommerce` is chain-`97` only; `scripts/verify-manifest.ts` runs the commerce compatibility probe only when `chainId === 97` and leaves `commerceCompatibility: null` for chain `56`. Every escrow, settlement and refund in `evidence/testnet/` is test `U` on chain `97`. Consequently nothing in this repository demonstrates that KNOT handles real money safely. The absence of mainnet loss is the absence of mainnet activity, not evidence of mainnet safety.

Related: the mainnet manifest asserts in `packages/chain/src/manifest.ts` that both installed SDKs declare the same chain-`56` policy `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5`. Unlike the chain-`97` case, that agreement is a repository assertion, not a runtime-verified observation — no code cross-checks the two SDK declarations for chain `56`.

### The evaluator is team-operated

All four sellers and all four non-agent reference implementations used in the Advantage Lab pairs are operated by KNOT. `evidence/claims.json` states this directly under `comparative-benchmarks`: "All four sellers and reference implementations are operated by KNOT; evaluator independence means scores are recomputed from raw evidence, not independent business ownership." Evaluator independence here means the scoring code recomputes outcomes from retained raw evidence. It does not mean a second party ran the comparison. The four published quality outcomes are ties, and a tie is reported as a tie.

The Shield security corpus is in the same position: six team-owned synthetic fixtures with team-adjudicated labels, producing 2 true positives, 0 false positives and 7 false negatives across 9 adjudicated findings, and 0 true positives with 3 false negatives on the ERC-1967 holdout. Manual validation sits inside the measured pipeline and rejected two mapped analyzer signals before scoring, so the reported false-positive count is post-validation. This is not an independent external benchmark and is not audit-quality coverage.

### RPC providers are trusted for liveness, and the two pinned providers are not independently operated

The dual-RPC agreement check detects disagreement. It does not detect two providers returning the same wrong answer. Worse, both pinned BSC testnet endpoints in `packages/chain/src/manifest.ts` — `https://data-seed-prebsc-1-s1.bnbchain.org:8545` and `https://bsc-testnet-dataseed.bnbchain.org` — sit under one domain owner, so the agreement check does not establish provider-operator independence. The same applies to the two mainnet endpoints, of which one is `bnbchain.org`. There is no light-client verification, no independent header check and no fraud proof anywhere in this repository. If every configured provider lies identically, the system accepts the lie.

Availability depends on those providers. When they are unreachable the system refuses rather than guesses, which is the right failure, but it is still a failure.

### The seller runtime holds its own key, and KNOT cannot constrain it

Each seller container is the sole key-holder for its ERC-8004 agent. `agents/<seller>/app/agent/src/signing.ts` loads the key through `@bnbagent/studio-runtime/wallet` and performs `signQuote`, `submitResult` and `settle` as fixed code. Mitigations inside that file are real but local: signing is never exposed as a model-callable tool, the price is a fixed `studio.toml` list price clamped before signing, and `verifySignedJob` checks that a funded job carries this agent's own signature. None of that is enforced by KNOT's backend. A compromised seller container can sign any quote within its own bounds, submit any deliverable and claim settlement on chain `97`. The KNOT API's only defences are downstream: quote verification before funding, and artifact hash and schema verification after delivery.

Note also that `priceBounds()` in that file defaults to `(0, 2^256-1)` when `min_price` and `max_price` are absent or empty, so the clamp is only a real bound when those values are configured.

### No transaction broadcaster exists, so an unknown outcome needs a human

The recovery kernel can only observe transaction hashes that were already journalled, for direct-EOA legacy transactions. An action that reaches `UNKNOWN` without a journalled hash stays `UNKNOWN`. There is no automatic resubmission, no relay path and no account-abstraction recovery. The deployed rollout observation confirms the idle case only: the queue was empty, with zero actions claimed, examined, changed or failed, so no queued receipt observation, lease, reconciliation transition, recovery retry or recovery effectiveness has ever been exercised in the deployed environment. The single deployed receipt read was one in-memory probe of existing transaction `0xee8c816faceaea83f0eb9745e72230bde2190f439a4cac9ef8181162d54582bf`, observed `SUCCESS` at block `130060913` with 11,022 confirmations. Reorg-after-terminal handling and lost-hash recovery are not measured.

### ERC-1271 contract signatures are not verified

`verifyOwnedSellerQuote` returns `status: "ERC1271_UNRESOLVED"` with a challenge payload for a contract provider, and the persistence layer only stores EIP-191 EOA quotes. A pinned-block ERC-1271 verifier does not exist. For external jobs `1191` and `1198` the pre-funding ERC-1271 results are capture-time evidence only: `1191` could not be historically rechecked because public RPC state was pruned, and `1198`'s funding-block check at block `130051329` may stop being reproducible for the same reason.

### Registry ownership can change between observations

For each external paid job, registry ownership was observed before funding and again at terminal capture. Nothing prevents a change between those two points. Separately, a distinct ERC-8004 owner address and a non-KNOT service URL do not establish that the controlling people or organisations are independent — recorded as a limitation on all three external job claims and on the `2293` audition.

### Delivered artifacts are public, and there is no retention or erasure mechanism

Deliverable manifests are readable over public HTTPS with no credential. The tunnel drill probes `https://knot-artifacts.truematchx.com/knot-deliverables/healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json` with only an `accept` header and records HTTP 200. Meanwhile `service_requests` and `verified_quotes` are append-only by database trigger, and no application code issues a `DELETE` — the only two `DELETE FROM` statements in the repository are negative tests asserting that those triggers refuse deletion. `artifacts.retention_until` is stored and returned by the API but never enforced. See `PRIVACY.md`.

### The deployment is a single point of failure, and availability is not claimed

One VPS, one Cloudflare tunnel, one PostgreSQL instance, one object store, one region. Every availability record is a single controlled observation from one client location: one 60.845-second availability window, one sequential container restart per seller, one operator-triggered `cloudflared` restart that recovered in 12,832 ms within its 120,000 ms bound. None establishes uptime, an SLA, failover, load capacity, host recovery or regional availability. The KNOT API has no rate limiter of its own; it binds to `127.0.0.1` and relies on the tunnel edge. Denial of service is not defended against and not measured.

The backup and restore interlock has only been exercised against command stubs, temporary directories and a disposable PostgreSQL database. No production restore, deployed active-action recovery, RPO, RTO or repeated recovery measurement is claimed. The snapshot completion marker is a co-located integrity checksum, not an authenticity signature — an attacker with write access to the snapshot directory can forge both.

### One API token, one buyer, no multi-tenancy

The API has exactly one bearer token and exactly one buyer address, both from the environment. The buyer is never taken from the request. There are no per-user accounts, no scopes, no token rotation mechanism and no audit trail of who used the token. Compromise of `/etc/knot/api.env` grants full access to every private record. The system is single-operator by construction; it is not hardened for untrusted callers.

### Not analysed at all

The following have received no analysis and no measurement in this repository: timing and side-channel attacks on the quote or authority paths; economic or MEV attacks against settlement ordering; collusion between a seller and the evaluator; supply-chain compromise of the installed npm dependencies beyond lockfile pinning; TLS PKI compromise, since `safeFetch` pins a resolved IP address but relies on the platform trust store; physical or host-level compromise of the VPS; abuse of the LLM credential path in the seller images, which is configured but unused by every analysis path (`buildRunWork` in all four sellers returns a deterministic analyzer, not a model call).

## Related documents

- `DECISIONS.md` — why these boundaries were chosen, and what was rejected.
- `COMPATIBILITY.md` — the pinned dependency and contract matrix these checks compare against.
- `PRIVACY.md` — what is public, what is permanent, and what is redacted.
- `evidence/claims.json` — the closed claim ledger, with a status, evidence class and explicit limitations for each of 31 claims.
- `REPRODUCE.md` — the commands that re-run each check.
