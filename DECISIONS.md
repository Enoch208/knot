# Engineering decisions

Load-bearing decisions, each with the alternative that was rejected and the file that carries the decision. These are the choices that constrain what KNOT is allowed to claim.

## Index

| # | Decision |
| --- | --- |
| D1 | Ship analysis capability, not execution capability |
| D2 | Read BSC mainnet, transact only on BSC testnet |
| D3 | Resolve the two SDKs' conflicting testnet policy address at runtime, not by hardcoding one |
| D4 | Pin contract bytecode and proxy implementations, and fail closed on drift |
| D5 | Keep work state and money state as separate records |
| D6 | Never collapse an unknown transaction outcome into success or failure |
| D7 | Give every claim an evidence class and a status instead of a single "verified" flag |
| D8 | Make service requests, quotes and identity observations append-only |
| D9 | Verify seller identity from two RPC providers at one confirmed block |
| D10 | Carry the exact request bytes into the on-chain job description |
| D11 | Route every outbound HTTPS call through a DNS-pinned egress boundary |
| D12 | Keep signing inside the seller runtime, out of the marketplace backend |

---

## D1. Ship analysis capability, not execution capability

**Context.** A marketplace that says "execution" sells a much better story than one that says "analysis". The honesty invariant in this repository is that an execution badge requires an unattended worker, a real trigger evaluation, a bounded action and a verified post-state. KNOT has none of those.

**Decision.** Every seller is labelled `analysis` and only analyses. The type system enforces the label rather than trusting it: `taskSpec` refuses spend limits unless the capability is `execution`, refuses an `execution` task with no execution chain, and refuses `executionChainId !== dataChainId` with the message `executionChainId must equal dataChainId: analysis of one network never authorizes execution on another`. Every recorded task carries `executionChainId: null` and `mode: "analysis"`.

**Rejected.** Shipping a thin execution wrapper — a signed swap behind a spend cap — to earn an execution badge. Rejected because a single demonstrated swap is not an unattended worker with a verified post-state, so the badge would have been a claim the evidence could not carry. A reviewer can falsify a badge with one explorer query; the sentence has to be narrower than the implementation.

**Consequence.** No liquidity position, order, swap, deposit, withdrawal or migration has ever been executed by KNOT on any network, and every analyzer artifact carries its own limitation lines saying so. GridQuant reports `completedTradeCount: 0` with basis `NO_OBSERVED_FILLS` rather than a modelled return. The bounded-authority evidence deliberately grants only `balanceOf(address)` (selector `0x70a08231`) plus a 0.005 `tBNB` hourly native cap, and demonstrates that `totalSupply()` is rejected with `UnauthorizedCall` and that the formerly allowed read is rejected with `KeyDoesNotExist` after revocation.

**Where.** `packages/contracts/src/task.ts`, `packages/services/*`, `evidence/testnet/bounded-authority-grant-revoke.json`.

---

## D2. Read BSC mainnet, transact only on BSC testnet

**Context.** Useful DeFi analysis needs real positions, real pools and real rates, which exist on BSC mainnet (`56`). A hackathon-timescale payment system moving real money is a liability.

**Decision.** Split the networks by purpose. Financial input data is read from chain `56` and pinned as a snapshot. Identity, quoting, escrow, delivery and settlement happen on chain `97` in test `U`. The split is structural, not conventional: `MAINNET.writeEnabled` is `false` in `packages/chain/src/manifest.ts`, the retained `ops/manifests/network-56.json` records `writesPermitted: false`, and `scripts/verify-manifest.ts` only runs the commerce write-readiness probe when `chainId === 97`.

**Rejected.** Two alternatives. Running commerce on mainnet with tiny amounts — rejected because a small real payment is still a real payment, and one incorrect refund path would be an actual loss with no test coverage behind it. Running analysis against testnet data — rejected because testnet pools and lending markets carry no meaningful state, so every comparison would have measured nothing.

**Consequence.** Every price, gas figure and balance in the product must name its network. Testnet gas is never reported as dollars and a testnet balance is never called revenue. The cost of this decision is stated plainly in `THREAT_MODEL.md`: mainnet fund safety is untested because it has never been exercised.

**Where.** `packages/chain/src/manifest.ts`, `scripts/verify-manifest.ts`, `ops/manifests/network-56.json`, `ops/manifests/network-97.json`.

---

## D3. Resolve the two SDKs' conflicting testnet policy address at runtime, not by hardcoding one

**Context.** The two installed SDKs disagree about the BSC testnet ERC-8183 policy contract. `@altananetwork/sdk@0.7.1` declares `0x4F4678D4439feC812Ac7674Bb3Efb4C8f5Fb78A6`; `@bnbagent/sdk@0.5.5` declares `0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA`. They agree on commerce, router, registry and payment token. One SDK is a peer dependency of the other, so both are installed and neither can simply be removed.

**Decision.** Treat the disagreement as data. `verifyTestnetCommerce` collects the deduplicated policy set declared by both SDKs, and for each candidate reads five live values from chain: code hash, router whitelist status, the policy's bound commerce address, the policy's bound router address, and its dispute window. A candidate is `compatible` only when all five pass. The probe then requires **exactly one** compatible policy; zero or two is a refusal reason, not a tie-break. The winner becomes `selectedPolicy`, and `declarationConflict` is recorded as `true` in the retained manifest so the conflict stays visible after it is resolved.

**Rejected.** Three alternatives.

- Hardcoding `0xd6a421...` because it is the one that works. Rejected because a hardcoded address stops being checked. If the router later de-whitelists it, or the deployment moves, a constant would keep the write path open against a dead policy.
- Preferring one SDK by name. Rejected for the same reason: it encodes a guess about which vendor is right rather than asking the chain.
- Accepting any compatible policy. Rejected because two live compatible policies would mean the deployment is genuinely ambiguous, and an ambiguous deployment must not authorise a payment.

**Consequence.** The retained chain-`97` observation at block `130057538` records the resolution in full: the Altana-declared policy has code hash `0x10b1f9306d2a03557471d90a8624e7f758757b736b44d1e25ef3eba83ed96812`, is **not** whitelisted by the router, declares an `86400`-second dispute window, and is `compatible: false`; the bnbagent-declared policy has code hash `0xe06798700c986d4387898a1dfde009d52c75f77c7d8dd1a3e179c02d5138cb9b`, is whitelisted, declares a `900`-second dispute window, and is `compatible: true`. The 900-second window then flows into the hire path: `prepareHire` refuses any job whose `expiredAt` does not exceed `now + disputeWindowSeconds` for the selected policy.

Note the asymmetry recorded in `THREAT_MODEL.md`: no equivalent runtime cross-check exists for chain `56`, where the manifest asserts that both SDKs declare the same policy.

**Where.** `packages/commerce/src/compatibility.ts`, `packages/commerce/src/deployments.ts`, `packages/commerce/src/hire.ts`, `ops/manifests/network-97.json`.

---

## D4. Pin contract bytecode and proxy implementations, and fail closed on drift

**Context.** Commerce, router and registry on both networks are 130-byte ERC-1967 proxy stubs. Their behaviour lives in an implementation that can be replaced without the address changing.

**Decision.** Pin a code snapshot — chain `97`, block `129987120`, observed `2026-09-09T07:59:06Z` — containing the code hash of every proxy, every implementation and the payment token. Before any write is permitted, re-read all of them plus the ERC-1967 implementation slot, and require an exact match. Independently, `scripts/verify-manifest.ts` diffs each observation against the previously retained manifest and reports bytecode or implementation changes as suspensions; a write-enabled network with any suspension exits non-zero.

**Rejected.** Checking only the proxy address, which is what most integrations do. Rejected because the proxy address is exactly the value that does not change during a malicious or careless upgrade. Also rejected: warning and continuing. `requireCommerceWriteReady` throws with the accumulated reasons and has no override.

**Consequence.** The write gate is a single choke point rather than a scattered set of assertions, and the retained manifests are reviewable artifacts — `npm run manifest:verify` rewrites them, and the operator is expected to inspect the Git diff before retaining a new observation.

**Where.** `packages/commerce/src/deployments.ts`, `packages/commerce/src/compatibility.ts`, `packages/chain/src/erc8004-identity.ts`, `scripts/verify-manifest.ts`.

---

## D5. Keep work state and money state as separate records

**Context.** The tempting model is one job status: `pending → running → delivered → paid`. It is wrong, because delivery and payment fail independently. A seller can deliver perfect work and never get paid; a buyer can fund escrow and receive nothing.

**Decision.** Three independent state machines over three columns, each with its own transition table and its own assertion function. Work state runs `DRAFT → QUOTED → AWAITING_PAYMENT → PAYMENT_OBSERVED → RUNNING → OUTPUT_RECEIVED → OUTPUT_CHECKED` with `FAILED`, `EXPIRED` and `CANCELED` as terminals. Money state runs `UNFUNDED → FUNDING_PENDING → ESCROWED → RESOLUTION_PENDING → PAID | REFUNDED`, plus `UNKNOWN`. Chain-action state runs `PREPARED → SUBMITTED → CONFIRMED | FAILED`, plus `UNKNOWN`. The database mirrors all three as `CHECK` constraints so an out-of-band write cannot introduce a state the code does not know.

**Rejected.** A single status enum, or a boolean `paid` flag alongside a work status. Rejected because both encode the assumption that the two lifecycles move together, and the recorded evidence shows four cases where they did not: job `1180` reached a hash-matched submission whose artifact was `INVALID_REQUEST`/`INVALID_JSON` and whose full escrow was refunded; jobs `1191`, `1198` and `1203` were funded with acknowledgement but no deliverable, each ending `EXPIRED` with the exact escrow refunded and `providerPaymentBaseUnits: "0"`.

**Consequence.** The API error model carries the same separation outward. Every `ApiError` has an explicit `SafeFinancialState` — `unfunded`, `funded_unsettled`, `settled`, `refunded` or `unknown` — that defaults to `unknown`, so a transport failure can never be read as a settlement.

**Where.** `packages/db/src/state-machine.ts`, `packages/db/src/types.ts`, `packages/db/migrations/0001_domain.sql`, `apps/api/src/errors.ts`.

---

## D6. Never collapse an unknown transaction outcome into success or failure

**Context.** A broadcast whose receipt cannot be read is the most dangerous state in a payment system. Calling it a failure invites a duplicate payment. Calling it a success invites a phantom one.

**Decision.** `UNKNOWN` is a first-class state with restricted exits. In `actionTransitions`, `UNKNOWN` may become only `CONFIRMED` or `FAILED`; there is deliberately no `UNKNOWN → SUBMITTED` edge, so nothing in the type system can express a resubmission. The reconciler maps every ambiguous outcome into it: no observation at all, an observation failing structural validation, or an observation whose chain id, transaction-intent hash, signer, nonce or transaction hash does not match the journalled action. Only a valid, binding-matched receipt with at least the configured confirmations becomes terminal. An abort during shutdown propagates instead of writing an outcome, and the fenced lease is released unchanged.

**Rejected.** Two alternatives. A retry with a fresh nonce, which is the usual fix and the usual way to pay twice. And an optimistic mark-as-failed after a timeout, which the repository rules forbid outright: timeout is neither failure nor success.

**Consequence.** Recovery is strictly an observer. It supports only already-journalled transaction hashes for direct-EOA legacy transactions; there is no broadcaster, no relay path and no account-abstraction recovery. A hashless unknown therefore stays unknown until a human reconciles it. That is a deliberate cost, and it is stated as a gap in `THREAT_MODEL.md` rather than presented as a feature.

**Where.** `packages/db/src/state-machine.ts`, `apps/worker/src/chain-action-reconciler.ts`, `apps/worker/src/bsc-chain-receipt-observer.ts`.

---

## D7. Give every claim an evidence class and a status instead of a single "verified" flag

**Context.** "Verified" is the least informative word in this domain. It flattens a mainnet read, a testnet transaction, a replayed dataset, a fixture and a vendor's own status page into one badge.

**Decision.** `evidence/claims.json` gives each of its 31 records a status from `SUPPORTED`, `PARTIAL`, `UNMEASURED`, `NOT_CLAIMED`, one or more evidence classes from `mainnet_observation`, `testnet_observation`, `historical_replay`, `synthetic_fixture`, `publisher_claim`, a scope, its sources, and an explicit `limitations` list. Tiers are never promoted automatically. The vocabulary is also a runtime type: `evidenceClass` is a Zod enum in `packages/contracts/src/primitives.ts` and a `CHECK` constraint on the `claims` table.

**Rejected.** A boolean, or a percentage score. A boolean forces every partial result to round to true or false, and the interesting records here are precisely the partial ones — the `2293` audition is `PARTIAL` because a read-only preflight confirmed registration and a live A2A card but verified no compatible callable task, no quote capability, no hireability and no operator independence.

**Consequence.** Limitations are attached to the claim rather than kept in a separate caveats page, which means they cannot drift apart from the number they qualify. The four Advantage Lab pairs carry the limitation that all sellers and reference implementations are KNOT-operated; the paid-flow claims carry the limitation that one job establishes no repeatability; the availability claims carry the limitation that client-observed HTTP responses are not uptime. `npm run claims:verify` runs as part of `npm run check`.

**Where.** `evidence/claims.json`, `packages/evidence/src/claim-schema.ts`, `packages/evidence/src/claim-verifier.ts`, `packages/contracts/src/primitives.ts`, `packages/db/migrations/0003_product_records.sql`.

---

## D8. Make service requests, quotes and identity observations append-only

**Context.** Evidence that can be edited is not evidence. If the row proving what a buyer asked for can be rewritten after the fact, the on-chain hash it is supposed to explain proves nothing.

**Decision.** Enforce immutability in the database, not the application. `service_requests`, `verified_quotes` and `erc8004_identity_observations` each carry `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that raise. Insert-time triggers verify the bindings that matter — the service request's task, buyer, category, input hash and snapshot must match the task row exactly; the verified quote's service request, task boundary, payment boundary, agent identity and endpoint observation must all agree; identity observations refuse any contradiction with an existing observation at the same chain and block. A task that already has a service request becomes immutable, and an agent or endpoint observation bound to a verified quote cannot be altered or deleted.

**Rejected.** Application-level immutability. Rejected because the operator has direct database access, so a check that lives only in TypeScript is a check that can be bypassed by the one person most motivated to bypass it. Also rejected: soft deletes, which reintroduce a mutable field.

**Consequence.** The database is a ratchet. Retries are exact-idempotent by construction — an identical retry returns the stored row, and a conflicting one raises `IdempotencyConflictError` mapped to `409 CONFLICT`. The price is the privacy gap recorded in `PRIVACY.md`: append-only rows have no retention or crypto-erasure path, which is why the intake boundary is scoped to bounded testnet and demo inputs rather than production portfolio data.

**Where.** `packages/db/migrations/0008_service_requests.sql`, `0009_service_request_transport.sql`, `0010_verified_quotes.sql`, `0011_erc8004_identity_observations.sql`.

---

## D9. Verify seller identity from two RPC providers at one confirmed block

**Context.** A quote is only meaningful if the signer is the registered owner of the agent being hired. A single RPC read is a single point of trust for that binding.

**Decision.** Read the ERC-8004 identity from two pinned BSC testnet providers at `head - 3`, require unanimous agreement on owner, agent wallet and token URI, re-read the block hash after the identity reads to detect a reorganisation, and reject a block older than 30 seconds. Alongside the identity, each read re-verifies the registry proxy code hash, the ERC-1967 implementation address and the implementation code hash against the pin. The owner must have no code at that block, so a contract cannot pose as an EOA owner. The resulting `rpc_agreement` envelope is persisted with `providerCount >= 2` and `agreementCount = providerCount` enforced as `CHECK` constraints.

**Rejected.** A single-provider read with a retry. Rejected because a retry against the same provider re-asks the same source. Also rejected: trusting the 8004scan index for ownership — the index is used for discovery breadth and is explicitly untrusted for facts, which is why `is_verified=false` from the index is published as a discrepancy rather than acted on.

**Consequence.** Identity failures are typed and distinguishable: `RPC_DISAGREEMENT`, `STALE_BLOCK` and `ORPHANED_OBSERVATION` map to a retryable `503`, while `DEPLOYMENT_MISMATCH` and `IDENTITY_MISMATCH` map to a non-retryable `502 RESULT_INCOMPLETE`. The honest limit is that agreement between two endpoints under one domain owner is not provider independence; see `THREAT_MODEL.md`.

**Where.** `packages/chain/src/erc8004-identity.ts`, `packages/db/migrations/0011_erc8004_identity_observations.sql`, `apps/api/src/app.ts`.

---

## D10. Carry the exact request bytes into the on-chain job description

**Context.** ERC-8183 anchors a job description on chain, and the seller signs a quote over it. If the description is prose while the seller works from a separate payload, the signature covers a summary rather than the actual instruction, and a dispute has nothing objective to resolve against.

**Decision.** Encode the exact UTF-8 JSON request bytes into the description with a versioned transport prefix — `knot-json-base64url/1:` or `knot-json-deflate-base64url/1:` — so the anchored description *is* the request. `keccak256` of those bytes is bound to the task's `inputHash` by a database `CHECK` for the three `EXACT_REQUEST_BYTES` categories. Compression exists to fit the limit: the description must leave an 896-byte reserve (`SERVICE_REQUEST_QUOTE_RESERVE_BYTES`) below the SDK's ERC-8183 description limit for the signed quote envelope, and requests may be up to 65,536 bytes decoded. The `health` category is restricted to uncompressed `base64url` — "HealthGuard v1 does not support compressed transport" — and that restriction is enforced in both the Zod schema and the database `CHECK`.

**Rejected.** Anchoring only a hash and passing the payload out of band. Rejected because a hash alone cannot be decoded by a third party, so an independent reviewer could not reconstruct what was bought. Also rejected: a human-readable prose description, which cannot be byte-compared and would have made the `1180` incident unattributable.

**Consequence.** Anyone can decode a KNOT job's task from chain `97`. Job `1187` anchored 1,084 compressed bytes decompressing to 2,572 bytes, and the verification record confirms `onChainDescriptionMatches: true` and `taskBytesMatch: true`. This is the correct trade for verifiability and the wrong trade for confidentiality — `PRIVACY.md` states the consequence in full.

**Where.** `packages/contracts/src/service-request.ts`, `packages/db/migrations/0008_service_requests.sql`, `0009_service_request_transport.sql`, `evidence/testnet/analysis-paid-jobs-1187-1189.json`.

---

## D11. Route every outbound HTTPS call through a DNS-pinned egress boundary

**Context.** The system fetches agent cards, registration proofs and deliverables from hostnames supplied by a public registry. Any of those can point at the host's own network.

**Decision.** One boundary, `safeFetch`, that validates the URL, resolves the hostname, rejects the entire resolution set if any address is non-public, connects to the accepted address with the original hostname as TLS `servername`, re-validates and re-resolves every redirect hop, refuses to carry `authorization` or `x-api-key` across an origin boundary, restricts request headers to a five-name allowlist, and applies one wall-clock deadline across resolution, redirects and transfer. Call sites tighten it further: the public seller verifier and the owned-seller client both set `maxRedirects: 0`.

**Rejected.** A hostname denylist, or validating the URL and then handing it to `fetch`. Both are the classic DNS-rebinding gap: the name checked is not the address connected to. The split between `resolvePublicAddresses` and `nodeHttpsTransport` exists precisely to close it.

**Consequence.** Seven frozen adversarial cases are retained in `evidence/security/safe-fetch-cases.json`, including an IMDS IP literal, a mixed public and private resolution set, a redirect into IMDS, an oversized response, embedded credentials and an IPv6 documentation range. The stated limitation is that only call sites using this boundary get these protections.

**Where.** `packages/security/src/safe-fetch.ts`, `packages/security/src/address-policy.ts`, `packages/security/src/owned-seller-client.ts`, `packages/discovery/src/public-sellers.ts`.

---

## D12. Keep signing inside the seller runtime, out of the marketplace backend

**Context.** A marketplace that holds seller keys is a custodian. It is also a single compromise away from being able to sign on behalf of every agent it lists.

**Decision.** Each seller container is the sole key-holder for its own ERC-8004 agent and performs `signQuote`, `submitResult` and `settle` itself as fixed code that is never registered as a model-callable tool. The KNOT backend holds no wallet secret at all: `ops/backend/secrets.schema.json` lists database, API, owned-seller OAuth, artifact-store, chain-read, PostgreSQL and object-store credentials, and no key material. No file under `packages/`, `apps/` or `scripts/` constructs a wallet client or broadcasts a transaction.

**Rejected.** A backend signer with per-seller delegation. Rejected because it would concentrate custody in the component with the largest attack surface, and because the marketplace should be able to say truthfully that it cannot spend on a seller's behalf.

**Consequence.** The backend's leverage over a seller is entirely verification-based: quote verification before funding, and artifact hash, schema, task and snapshot verification after delivery. A compromised seller container can still sign and settle within its own bounds, which is stated as an undefended gap in `THREAT_MODEL.md`. The current deployed quote route reflects the same conservatism — it returns `fundingPermitted: false` and has no wallet action, job creation, funding, notification, settlement or chain-write connection.

**Where.** `agents/<seller>/app/agent/src/signing.ts`, `ops/backend/secrets.schema.json`, `apps/api/src/app.ts`.

---

## Related documents

- `THREAT_MODEL.md` — the boundaries these decisions create, and what still gets through.
- `COMPATIBILITY.md` — the pinned versions and addresses D3 and D4 depend on.
- `PRIVACY.md` — the disclosure cost of D8 and D10.
- `evidence/claims.json` — the closed claim ledger D7 describes.
