# Privacy

What KNOT handles, what becomes permanently public, what stays off chain, what is redacted, and what a wallet address gives away. Every statement here names the network or the storage location it applies to.

The single most important fact in this document: **a KNOT job publishes the buyer's complete task on chain.** Not a hash of it — the task itself, encoded and recoverable by anyone. That is a deliberate verifiability trade, explained in `DECISIONS.md` (D10), and it is why the current intake boundary is scoped to bounded testnet and demo inputs rather than production portfolio data.

## Data inventory

| Data | Where it goes | Public? | Permanent? |
| --- | --- | --- | --- |
| Task specification (category, capability, chain ids, fee limit, deadline, input hash, snapshot id) | `tasks` table; embedded in the on-chain job description | Yes, once a job is funded on BSC testnet `97` | Yes |
| Service request bytes (the analyzer input: pool and token addresses, position NFT ids, principal sizes, price bounds, slippage, cooldowns) | `service_requests.request_bytes`; encoded into the on-chain job description | Yes, once funded | Yes |
| Signed quote envelope (price, currency, negotiation hash, provider signature, expiry) | `verified_quotes`; the signed job description anchored on chain | Yes, once funded | Yes |
| Buyer wallet address | Every commerce transaction on chain `97` | Yes | Yes |
| Seller wallet address | ERC-8004 registry and every commerce transaction on chain `97` | Yes | Yes |
| Escrow amount, funding, settlement and refund transfers | ERC-8183 commerce on chain `97`, in test `U` | Yes | Yes |
| Deliverable manifest hash and deliverable URL | Published on chain by the seller's `submit` | Yes | Yes |
| Deliverable artifact bytes | Object store, served over public HTTPS | Yes — no credential required | Until deleted from the store; the on-chain hash is permanent |
| BSC mainnet snapshot (block number, block hash, pool or market state) | `snapshots` table and the artifact's evidence block | Yes; it is already public chain data | Yes |
| Seller OAuth client id and secret | `/etc/knot/owned-sellers.env`, mode `0600` | No | Until rotated |
| API bearer token, configured buyer address, allowed origin | `/etc/knot/api.env`, mode `0600` | No | Until rotated |
| Seller signing key | Seller container keystore, unlocked by `WALLET_PASSWORD` from the runtime secret store | No | Until rotated |
| Database, object-store and RPC credentials | `/etc/knot/{database-client,postgres,object-store,artifact-client,chain-read}.env`, all mode `0600` | No | Until rotated |
| Endpoint observation details | `endpoint_observations.safe_details` | Not published; and structurally cannot contain a response body | Append-only |
| Correlation ids | API response header `x-correlation-id`, API error bodies | Returned to the caller only | Not persisted as a record of its own |
| Session permission grants | `sessions.permissions`; the on-chain key-store grant on chain `97` | The on-chain grant is public | Yes for the on-chain part |

There is no end-user account system. There are no cookies, no analytics, no session tracking and no third-party scripts in `apps/web`, which is a read-only public projection holding no credential.

## Written on chain, therefore public and permanent

All of the following lands on **BSC testnet (`97`)**. No KNOT write of any kind has ever been made to BSC mainnet (`56`); mainnet is read-only in this system.

### The job description carries the whole task

`packages/contracts/src/service-request.ts` encodes the exact UTF-8 JSON request bytes into the ERC-8183 job description with a versioned transport prefix — `knot-json-base64url/1:` or `knot-json-deflate-base64url/1:`. That description is the string passed to `buildHireCalls` and submitted in the funding transaction. It is not a digest. Anyone with an RPC endpoint or a block explorer can decode it.

Worked example, from `evidence/testnet/analysis-paid-jobs-1187-1189.json` and `evidence/advantage/gridquant-1187/job-1187.json`. GridQuant job `1187` anchored a `deflate-base64url` description of 1,084 compressed bytes that decompresses to 2,572 bytes, and the verification record confirms `onChainDescriptionMatches: true` and `taskBytesMatch: true`. Decoding it recovers, among other fields:

| Field | Value now public on chain `97` |
| --- | --- |
| `taskId` | `grid-paid-120868475` |
| PancakeSwap v3 pool | `0x172fcd41e0913e95784454622d1c3724f546f849` |
| Base token (WBNB) | `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` |
| Quote token (USDT) | `0x55d398326f99059ff775485246999027b3197955` |
| Principal | `1000000000000000000000` units |
| Price bounds | `71149` to `78638`, two decimals |
| Grid count and spacing | `5`, arithmetic |
| Order size floor | `100000000000000000000` units |
| Maximum inventory exposure | `10000000000000000000` units |
| Slippage tolerance | `5` bps |
| Cooldown | `300` seconds |
| Deadline and expiry | `2026-09-09T12:01:01.000Z`, `2026-09-09T11:45:08.246Z` |
| Pinned mainnet snapshot | block `120868475`, hash `0x03fe680e1d669e4e3f05d7284e342a0867c093bf7c13bc196b75eadd26f6418a` |

The equivalent applies to the other categories: a RangePilot job publishes the PancakeSwap v3 position NFT id, its position manager and its pool; a YieldScout job publishes the compared markets; a HealthGuard job publishes the lending-position parameters it was asked to assess. Job `1203`'s task description names position NFT `7391321`, position manager `0x46a15b0b27311cedf172ab29e4f4766fbe7f4364` and pool `0x172fcd41e0913e95784454622d1c3724f546f849` in plain text.

**Consequence.** Do not put anything in a KNOT service request that you are not willing to publish permanently. A position size, a risk threshold, a rebalancing trigger or a wallet under analysis is disclosed the moment the job is funded.

### The rest of the on-chain record

| Item | Detail |
| --- | --- |
| Buyer and provider addresses | Both appear as parties on every job |
| Budget and currency | e.g. `100000000000000000` base units of test `U` (`0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`), displayed as `0.1 U` |
| Negotiation hash and provider signature | e.g. job `1189` anchored `negotiation_hash` `0x5e58ab30b96930d4db552898ee19e2cf4268eb7f446c97049d8db1ab9c9cca51` with a 65-byte EIP-191 `provider_sig` |
| Deliverables and quality-standards text | Human-readable, inside the signed job description |
| Deliverable manifest hash | e.g. job `1187` submitted `0xa85e65d09fcf5566ecb62397d311605e4080df29fcf71d115f9897fca443ac77` |
| Deliverable URL | Published by `submit` so the buyer can fetch the manifest without a log scan |
| Lifecycle timing | Create, register, set-budget, fund, submit, settle or refund transactions, each with a block, timestamp and gas figure |
| Value movement | e.g. settlement of job `1187` transferred `100000000000000000` of `U` from commerce `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` to seller `0x3D5355A97352f4D078016342AD117a5E88D5C74f` |
| Session authority grants | The bounded-authority run published its grant, its one allowed `balanceOf(address)` call and its revocation as three separate transactions on chain `97` |

Balance changes are inherently visible. The retained record shows the buyer moving from `1800000000000000000` to `1500000000000000000` base units of `U` across three paid jobs. Anyone can read that.

## Delivered artifacts are publicly readable

Deliverable manifests are served from `https://knot-artifacts.truematchx.com/knot-deliverables/<seller>/sha256/<digest>.json` and require **no credential**. This is verified rather than assumed: the tunnel-recovery drill fetches `.../healthguard/sha256/581986011b035229c6fd5ccf50f321a962679bb8ae209d0d639169162469def2.json` with only an `accept: application/json` header — no `authorization`, no cookie — and the retained record shows HTTP 200 with a 1,546-byte body whose SHA-256 matches.

The manifest embeds the full analyzer artifact. For GridQuant job `1187` that is a 3,582-byte document containing every computed grid level, the capital plan, the fee model, the parameter checks and the limitation lines.

Content addressing makes this worse for confidentiality and better for integrity: the URL contains the artifact's own SHA-256, so a URL leak is a content leak, and the digest is anchored on chain regardless.

**Consequence.** Treat any KNOT deliverable as published. There is no private-delivery mode.

## Held off chain

| Store | Contents | Access |
| --- | --- | --- |
| PostgreSQL | `tasks`, `service_requests`, `verified_quotes`, `jobs`, `job_events`, `chain_actions`, `sessions`, `snapshots`, `agents`, `endpoint_observations`, `erc8004_identity_observations`, `artifacts`, `outbox` and the audition and benchmark tables | On the `knot_backend_private` Docker network, declared `internal: true`. The only port published by `ops/backend/compose.yaml` is `127.0.0.1:3100:3000` for the API; PostgreSQL and the object store publish none |
| Object store (MinIO) | `knot-artifacts` (internal) and `knot-deliverables` (served publicly) | `knot-artifacts` is created with `mc anonymous set none` and a scoped IAM-style policy limited to `GetObject`/`PutObject` on that bucket for one named user |
| Mode-`0600` environment files | Every credential listed in `ops/backend/secrets.schema.json` | Root-only on the host; never in Git |

`ops/backend/secrets.schema.json` contains no key material for the KNOT backend — no keystore, no mnemonic, no private key. Grep for a signing path in `packages/`, `apps/` or `scripts/` and you will find none: `createWalletClient`, `privateKeyToAccount`, `writeContract`, `sendTransaction` and `sendRawTransaction` appear only in test fixtures.

The private API surface is genuinely private. Task, service-request, verified-quote and job routes require a bearer token; mutation routes additionally require an exact `Origin` and an `Idempotency-Key` equal to the immutable resource identifier. Only `/health` and `/api/status` are unauthenticated, and both return exactly four fields: service name, status, check time, and a database status.

## Redaction and minimisation

Redaction here is structural — the code cannot construct the unsafe value — rather than a filter applied to a log line at the end.

| Mechanism | Effect | File |
| --- | --- | --- |
| Closed `safe_details` schema | An endpoint observation may contain only `schemaVersion`, `sellerKey`, `transportVersion`, `httpStatus`, `responseByteLength` and `responseSha256`. The key set is compared against that exact sorted list, so no seventh field can be stored. A seller's response body and any bearer token are structurally excluded; only a length and a digest survive | `packages/db/src/endpoint-observation-repository.ts` |
| Fixed error strings | Every `OwnedSellerClientError` message is a constant — "owned seller response is invalid", "owned seller request did not complete" — and never interpolates upstream text, status text or response bytes | `packages/security/src/owned-seller-client.ts` |
| Fixed API explanations | Every `ApiError` explanation is a literal sentence. Internal exception text never reaches the response body; a stored-data validation failure becomes "Stored data failed integrity validation." | `apps/api/src/app.ts`, `apps/api/src/errors.ts` |
| Credentials rejected in URLs | A URL with a username or password raises `EMBEDDED_CREDENTIALS` before any request, so a credential can never end up in a resolved-URL field | `packages/security/src/address-policy.ts` |
| Header allowlist | Only `accept`, `authorization`, `content-type`, `user-agent` and `x-api-key` may be sent; the `user-agent` is forced to `KNOT-safe-fetch/1`; values are capped and may not contain CR or LF | `packages/security/src/safe-fetch.ts` |
| Sensitive headers cannot cross an origin | An `authorization` or `x-api-key` header on a cross-origin redirect raises `UNSAFE_REDIRECT` rather than following it | `packages/security/src/safe-fetch.ts` |
| No secrets in the database | `sessions.secret_reference` stores a reference, not a secret. No table has a column for key material | `packages/db/migrations/0001_domain.sql` |
| Startup credential separation | The API refuses to start if two seller client secrets are equal, or if any seller secret equals `KNOT_API_AUTH_TOKEN` | `apps/api/src/owned-seller-config.ts` |
| Timing-safe token comparison | The bearer token is compared with `timingSafeEqual` over SHA-256 digests, so neither the value nor its length leaks through comparison timing | `apps/api/src/app.ts` |
| Backup scope exclusions | Snapshots capture a quiesced logical PostgreSQL dump plus current object bytes, and explicitly exclude host configuration and secrets, PostgreSQL physical files and WAL, prior object versions, bucket metadata, in-flight requests and external chain state | `ops/backend/snapshot-manifest.mjs` |
| Excluded from source control | Keystores, `.env*` files, credentials, internal planning documents and design dumps are excluded via `.git/info/exclude`; the tracked `.gitignore` covers only build and runtime artifacts | repository configuration |

Published evidence records are sanitised the same way. `evidence/operations/verified-quote-live-20260910.json` carries release tags, image digests, migration hashes, HTTP status codes, row counts and identity observations — and no token, no client secret and no raw seller response.

### Buyer inputs are never sent to a model provider

Every seller image ships a model-credential path, and HealthGuard additionally declares the `ai` package. Neither is used by the paid path: `buildRunWork()` in all four sellers returns a deterministic analyzer — `analyzeHealthGuardText`, `analyzeRangePilotText`, `analyzeGridQuantText`, `analyzeYieldScoutText`. No buyer task, service request or position data is transmitted to an LLM provider by the analysis path in this repository.

## Retention

This is the weakest area of the system, and the repository says so in its own claim ledger rather than in a footnote.

| Record | Retention today |
| --- | --- |
| `service_requests` | **Append-only, indefinite.** `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers raise "service requests are append-only". Raw request bytes are stored in full |
| `verified_quotes` | **Append-only, indefinite.** Same trigger pattern |
| `erc8004_identity_observations` | **Append-only, indefinite.** Same trigger pattern |
| `tasks` | Immutable once a service request binds to it |
| `artifacts` | A `retention_until` timestamp is stored and returned by the API, but **nothing enforces it**. No scheduled deletion, no expiry job, no lifecycle rule exists in this repository |
| Object-store deliverables | No lifecycle or expiry rule is configured in `ops/backend/compose.yaml`. `knot-artifacts` has versioning enabled, so an overwrite retains prior versions |
| On-chain records | Permanent by construction. Nothing can delete them |

There is no crypto-erasure mechanism: request bytes are stored as plaintext `bytea`, not as ciphertext under a destroyable key, so deleting a key cannot render a stored request unreadable. No application code performs a `DELETE` — the only two `DELETE FROM` statements in the repository are negative tests confirming that the append-only triggers refuse deletion.

`evidence/claims.json` records this directly, twice: "Raw request bytes are append-only without retention or crypto-erasure, so the deployed intake is limited to bounded testnet and demo inputs rather than production private portfolio data", and "Append-only service-request and quote data have no retention or crypto-erasure mechanism."

**Consequence.** KNOT is not currently suitable for production private portfolio data, and does not claim to be. A subject-access or erasure request could not be satisfied for on-chain data at all, and for off-chain data only by dropping the database.

## What a buyer's wallet address discloses

Everything below is inherent to a public blockchain, amplified by two choices in the current deployment.

| Disclosure | Detail |
| --- | --- |
| Full transaction history | Chain `97` for KNOT activity; the same address on any other chain if reused |
| Test `U` balance over time | e.g. `1800000000000000000` down to `1500000000000000000` across three paid jobs |
| Which agents were hired, and when | Every counterparty address and job id |
| What was asked for | Because the task is in the job description, not just its hash |
| Which analyses failed | Disputes, refunds and expiries are as public as settlements |
| Approvals and allowances | Public. The bounded-authority record shows the commerce allowance unchanged at `0` before and after that session |
| Session authority grants | The key-store grant, allowed selector, native spend cap and revocation are all separate public transactions |

Two amplifiers specific to this deployment:

1. **One buyer address for everything.** `KNOT_API_BUYER_ADDRESS` is a single configured value, and every evidence record uses buyer `0x71b1373FcdFfBD669B85D39b2Cfb37fFb9c62930`. Every KNOT job — HealthGuard `1180`, `1181`, `1185`, GridQuant `1187`, YieldScout `1188`, RangePilot `1189` — plus every external audition — `1191` against agent `2159`, `1198` against `2173`, `1203` against `1923` — is trivially linkable to that one address. Category, cadence and interests are all inferable from a single explorer query.
2. **Seller addresses are published deliberately.** `packages/discovery/src/public-sellers.ts` pins all four owner addresses in source. Any observer can enumerate KNOT's counterparties without touching the chain.

For an external provider, being paid by KNOT is itself disclosed: the external job records name the provider address, the ERC-8004 agent id, the registry-published name and the fact that the escrow was refunded and the provider received zero.

## What KNOT does not do

- No mainnet write, so no mainnet address is ever linked to a KNOT payment. Mainnet is read-only and reads are anonymous `eth_call`s.
- No collection of names, emails, phone numbers, IP-based profiles or device identifiers. `apps/web` contains no cookie, `localStorage`, analytics or third-party script reference, and loads no external script or font origin.
- No forwarded-IP header is treated as an identity. Seller rate limiting explicitly refuses to derive a caller identity from request payload fields or forwarded IP headers, and enables a per-caller bucket only when the operator names a header its trusted edge sets after stripping caller-supplied values.
- No selling, sharing or secondary use of buyer data.
- No off-repository telemetry from the marketplace backend. The API and worker write structured lines to standard error only.

## For a reviewer

- Decode a job description from chain `97` yourself and confirm the task is recoverable.
- Fetch any deliverable URL with no credential and confirm HTTP 200.
- Grep `packages/`, `apps/` and `scripts/` for `DELETE FROM` and confirm there is none.
- Read the `limitations` array of `service-request-intake-boundary` and `owned-seller-quote-persistence-fence` in `evidence/claims.json`, which state the retention gap in the ledger itself.

## Related documents

- `THREAT_MODEL.md` — assets, adversaries, and the explicit list of what is not defended against.
- `DECISIONS.md` — D8 and D10 explain the append-only and on-chain-task choices and what they cost.
- `COMPATIBILITY.md` — the pinned contracts and addresses referenced here.
- `REPRODUCE.md` — commands to re-run every verification above.
