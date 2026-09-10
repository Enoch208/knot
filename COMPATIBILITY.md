# Compatibility

Exact versions, exact addresses, and the observed discrepancies between them. Everything here was read from `package.json`, the lockfiles, `ops/manifests/network-56.json`, `ops/manifests/network-97.json` and `packages/commerce/src/deployments.ts` in this repository. Where a value depends on a live read, the block number and observation time are given.

## Runtime and toolchain

| Workspace | Declared engine | Type system | Notes |
| --- | --- | --- | --- |
| Root (`knot`) | `node >=24.0.0` | TypeScript `5.9.3`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module: NodeNext` | Runs `.ts` directly through Node's native type stripping; `npm run build` is `tsc --noEmit` over `packages`, `apps`, `scripts`, `tests` |
| `apps/web` (`knot-web`) | `node >=24.0.0` | TypeScript `5.9.3` | Excluded from the root `tsconfig.json`; has its own `typecheck` and `build` |
| `agents/{healthguard,rangepilot,gridquant,yieldscout}` | `node >=22` | TypeScript `5.9.3`, tests via `tsx --test` | Four isolated pnpm workspaces, each with its own frozen `pnpm-lock.yaml` |

`@bnbagent/sdk@0.5.5` itself declares `node >=20`, so the binding floor is the repository's own `>=24.0.0`, not the SDK's.

The root `tsconfig.json` excludes `agents` and `apps/web`, so `npm run check` type-checks the marketplace in one pass and delegates the seller and web workspaces to their own commands. `npm run check` runs `build`, `web:build`, `claims:verify`, `test:root` and `category:parity`.

## Why the matrix is pinned

Three of the four moving parts are exact-pinned rather than ranged, because the chain-facing behaviour of this repository depends on the specific bytes a given version emits:

1. **A recorded incompatibility, not a hypothetical one.** Job `1180` on BSC testnet was funded and submitted with a hash-matched deliverable that was nevertheless `INVALID_REQUEST`/`INVALID_JSON`, after `@bnbagent/sdk 0.5.5` changed JSON array brackets to parentheses. The buyer disputed and recovered the full 0.1 `U` escrow through `claimRefund` after expiry. A caret range on that package would make the encoding a moving target underneath signed quotes and anchored job descriptions.
2. **Address registries ship inside the SDKs.** `packages/commerce/src/deployments.ts` reads `ERC8183_ADDRESSES` from `@altananetwork/sdk` and `NETWORKS` plus `BNB_CHAIN_ADDRESSES` from `@bnbagent/sdk`. A version bump can silently change which contracts the system believes it is talking to.
3. **Compatibility verification compares installed versions against declared ones.** `verifyTestnetCommerce` calls `readInstalledSdkVersions`, which resolves each package's own `package.json` on disk, and adds a refusal reason when the installed version differs from the pinned `"0.7.1"` / `"0.5.5"`. A range would make that check vacuous.

## Root dependency matrix

| Package | `package.json` | `package-lock.json` | Why this version |
| --- | --- | --- | --- |
| `@altananetwork/sdk` | `0.7.1` (exact) | `0.7.1` | Required at exactly `0.7.1` by `@bnbagent/sdk@0.5.5`'s peer range; supplies `ERC8183_ADDRESSES` |
| `@bnbagent/sdk` | `0.5.5` (exact) | `0.5.5` | Supplies `NETWORKS`, `BNB_CHAIN_ADDRESSES`, `MAX_DESCRIPTION_BYTES`, `buildJobDescription`, `buildDescriptionContent`, `NegotiationRequest`/`NegotiationResponse` and `sanitizeForClaim`; inside `>=0.5.5 <0.6.0` as required by `@bnbagent/studio-runtime@0.0.13` |
| `viem` | `2.56.3` (exact) | `2.56.3` | All chain reads, `keccak256`, `getAddress`, `recoverMessageAddress`, `hashMessage`. Satisfies `@bnbagent/sdk`'s `viem ^2.24.2` and `@altananetwork/sdk`'s `viem ^2.21.0` |
| `zod` | `4.1.13` (exact) | `4.1.13` | Every closed schema in `packages/contracts`, `packages/db`, `apps/api` |
| `pg` | `8.23.0` (exact) | `8.23.0` | PostgreSQL driver |
| `typescript` | `5.9.3` (exact, dev) | `5.9.3` | |
| `@types/node` | `24.10.1` (exact, dev) | `24.10.1` | Matches the `node >=24` engine |
| `@types/pg` | `8.23.1` (exact, dev) | `8.23.1` | |

The root lockfile resolves 44 installed packages. Transitively pulled in and worth naming because they are chain-relevant: `ox@0.14.44`, `porto@0.2.37`, `@wagmi/core@3.6.5`, `abitype@1.3.0` (and `1.2.3` nested under `viem`), `@noble/curves@1.9.1`, `@noble/hashes@1.8.0`, `@noble/ciphers@1.3.0`, `@scure/bip32@1.7.0`, `@scure/bip39@1.6.0`, `hono@4.13.7`, `ws@8.21.0`, `dotenv@16.6.1`, `zustand@5.0.0` (and `5.0.15` nested under `porto`). `porto` and `@wagmi/core` arrive through `@altananetwork/sdk`, not through any direct KNOT dependency.

Every root dependency is exact-pinned. There is no `^` or `~` anywhere in the root `package.json`.

## Seller workspace matrix

`agents/rangepilot/pnpm-lock.yaml`, `agents/gridquant/pnpm-lock.yaml` and `agents/yieldscout/pnpm-lock.yaml` are byte-identical (MD5 `0d2143cc23dc8fc70851a2c1d71dac8e`). `agents/healthguard/pnpm-lock.yaml` differs (MD5 `d1ce0f9057a870336aaa366dea0710e2`) because HealthGuard declares the `ai` package. Lockfile format is pnpm `9.0` with `autoInstallPeers: true`.

| Package | Declared in `package.json` | Resolved in the lockfile |
| --- | --- | --- |
| `@bnbagent/studio-runtime` | `0.0.13` (exact) | `0.0.13` |
| `@bnbagent/sdk` | `0.5.5` (exact) | `0.5.5` |
| `@a2a-js/sdk` | `>=0.3.14 <1.0` | `0.3.14` |
| `@aws-sdk/client-secrets-manager` | `^3.600.0` | `3.1127.0` |
| `express` | `^5.1.0` | `5.2.1` |
| `zod` | `^3.25.0` | `3.25.76` |
| `ai` (HealthGuard only) | `^7.0.29` | `7.0.93` |
| `tsx` (dev) | `^4.19.0` | `4.23.13` |
| `typescript` (dev) | `^5.5.0` | `5.9.3` |
| `@types/node` (dev) | `^22.0.0` | `22.20.1` |
| `@types/express` (dev) | `^5.0.6` | `5.0.6` |
| `viem` (transitive) | — | `2.56.3` |
| `mppx` (transitive) | — | `0.8.12` |

## Web workspace matrix

| Package | `package.json` | `apps/web/package-lock.json` |
| --- | --- | --- |
| `next` | `16.3.4` (exact) | `16.3.4` |
| `react` | `19.3.0` (exact) | `19.3.0` |
| `react-dom` | `19.3.0` (exact) | `19.3.0` |
| `viem` | `2.56.3` (exact) | `2.56.3` |
| `typescript` (dev) | `5.9.3` (exact) | `5.9.3` |
| `@types/react`, `@types/react-dom` (dev) | `19.3.0` (exact) | `19.3.0` |
| `@types/node` (dev) | `^24.3.1` | `24.3.1` |

## The peer-dependency chain

This is the constraint that fixes the whole matrix. Each link was read from the seller lockfile's resolution metadata and confirmed against the published package metadata on the npm registry.

```
@bnbagent/studio-runtime@0.0.13
  peerDependencies: { "@bnbagent/sdk": ">=0.5.5 <0.6.0" }
    -> @bnbagent/sdk@0.5.5
         peerDependencies: {
           "@altananetwork/sdk": "0.7.1",           (optional)
           "@turnkey/sdk-server": ">=7.0.0 <9.0.0", (optional)
           "@turnkey/viem":       ">=0.14.32 <0.15.0" (optional)
         }
           -> @altananetwork/sdk@0.7.1
```

The `@altananetwork/sdk` peer range is a single exact version, `0.7.1` — not a range, not a caret. Newer releases exist on the public npm registry (`0.8.0` and `0.9.0` are published), and neither can be installed alongside `@bnbagent/sdk@0.5.5` without violating its declared peer constraint. `@bnbagent/sdk@0.5.6` is also published and declares the identical `@altananetwork/sdk: 0.7.1` peer, so moving to it would not relax the Altana pin; it is not installed here and its effect on the ERC-8183 description encoding has **not been measured** in this repository.

The three `@turnkey/*` peers are optional and are not installed in any workspace. KNOT does not use a Turnkey signer.

## Verified contract matrix

### BSC mainnet, chain `56`

Observed `2026-09-09T16:46:45.504Z` at block `120912693` via `https://bsc-dataseed.bnbchain.org`. Retained at `ops/manifests/network-56.json`. `writesPermitted: false`. No commerce compatibility probe is run for this chain, so `commerceCompatibility` is `null`.

| Role | Address | Status | Code hash | Code size | ERC-1967 implementation | Implementation code hash |
| --- | --- | --- | --- | --- | --- | --- |
| commerce | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` | `READ_ONLY` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` | 130 | `0xd5f9b570c96b5d67702d508c0bfb8b3b09209787` | `0x795596ea32b0d4e651cdd8d10e52c18ad759406172f5780ef867d968d9389c39` |
| router | `0x51895229E12F9876011789B04f8698af06cCD6DA` | `READ_ONLY` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` | 130 | `0xf0cf8f47e5c035f16247ff16e9f367e477ee5007` | `0x5f95706fdeae0bf3ac092ee86998dde7b9ce3fdcb2c8082d40f0c7847122df6a` |
| policy | `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` | `READ_ONLY` | `0x79a469cc624bdb3a85350a6bd220c8368ebdc8c5a8e9cf9a431422db68419b1c` | 4413 | none (not a proxy) | — |
| registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `READ_ONLY` | `0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41` | 130 | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | `0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f` |
| paymentToken | `0xcE24439F2D9C6a2289F741120FE202248B666666` | `READ_ONLY` | `0xae12b1d61f7ed4febf649ccf319cb49a0e921cca3739dcb01b47d316049d46ff` | 2007 | none (not a proxy) | — |

`proxyAdmin` is recorded as `null` for all five roles: the ERC-1967 admin slot `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` read as the zero word at this block.

### BSC testnet, chain `97`

Observed `2026-09-09T16:46:51.135Z` at block `130057527` via `https://data-seed-prebsc-1-s1.bnbchain.org:8545`. Retained at `ops/manifests/network-97.json`. `writesPermitted: true`, with zero suspensions.

| Role | Address | Status | Code hash | Code size | ERC-1967 implementation | Implementation code hash |
| --- | --- | --- | --- | --- | --- | --- |
| commerce | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` | `VERIFIED` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` | 130 | `0x153783ddbdf5233c591965f04644b1df2d1a7815` | `0x949f04b966cde30955d1daca5bf8605eed67db9ddc2b1cf86ac018bf3bf2e08f` |
| router | `0xD7d36D66d2F1B608A0F943f722D27e3744f66F25` | `VERIFIED` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` | 130 | `0x40c0254610d92f1eb9c2d7d5d2114bc4c99d935e` | `0xb523939a51d980e6bb482b6362806d06b2d75cee4e230d4ccb25f9acf0e44d18` |
| policy | `0xd6a4217588f6b1f5657a92a3e94e6422ad771cea` | `VERIFIED` | `0xe06798700c986d4387898a1dfde009d52c75f77c7d8dd1a3e179c02d5138cb9b` | 4413 | none (not a proxy) | — |
| registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `VERIFIED` | `0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41` | 130 | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | `0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f` |
| paymentToken | `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565` | `VERIFIED` | `0xae12b1d61f7ed4febf649ccf319cb49a0e921cca3739dcb01b47d316049d46ff` | 2007 | none (not a proxy) | — |

`proxyAdmin` is `null` for all five roles here as well.

Two cross-chain observations fall out of the two tables: the ERC-8004 registry proxies on `56` and `97` share both code hash and implementation address `0x7274e874ca62410a93bd8bf61c69d8045e399c02`, and the mainnet and testnet payment tokens share the code hash `0xae12b1d6...46aff` with identical 2007-byte code size. Both are recorded as observations, not as conclusions about who deployed what.

### Pinned code snapshot

`packages/commerce/src/deployments.ts` holds `TESTNET_CODE_SNAPSHOT`: chain `97`, block `129987120`, observed `2026-09-09T07:59:06Z`. Its hashes are the values `verifyTestnetCommerce` compares every live read against.

| Snapshot key | Pinned hash |
| --- | --- |
| `commerce` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` |
| `commerceImplementation` | `0x949f04b966cde30955d1daca5bf8605eed67db9ddc2b1cf86ac018bf3bf2e08f` |
| `router` | `0x1f1858db4825be798342d4c094630bf5ddc685bd802a083d8d88f15a6cdb2a89` |
| `routerImplementation` | `0xb523939a51d980e6bb482b6362806d06b2d75cee4e230d4ccb25f9acf0e44d18` |
| `altanaPolicy` | `0x10b1f9306d2a03557471d90a8624e7f758757b736b44d1e25ef3eba83ed96812` |
| `bnbAgentPolicy` | `0xe06798700c986d4387898a1dfde009d52c75f77c7d8dd1a3e179c02d5138cb9b` |
| `registry` | `0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41` |
| `registryImplementation` | `0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f` |
| `paymentToken` | `0xae12b1d61f7ed4febf649ccf319cb49a0e921cca3739dcb01b47d316049d46ff` |

The registry implementation address `0x7274e874ca62410a93bd8bf61c69d8045e399c02` is the one value in `commonImplementations` written as a literal in source rather than read from an SDK registry. The commerce and router implementations come from `BNB_CHAIN_ADDRESSES[97].commerceImpl` and `.routerImpl`.

## The recorded SDK policy conflict, and how it resolves

The two installed SDKs declare **different** ERC-8183 policy contracts for BSC testnet and the **same** commerce, router, registry and payment token. The conflict is resolved against live chain state, not by preferring a vendor. Observed at block `130057538`, the same timestamp as the chain-`97` manifest:

| Candidate policy | Declared by | Code hash | Router-whitelisted | Bound commerce | Bound router | Dispute window | `compatible` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `0x4F4678D4439feC812Ac7674Bb3Efb4C8f5Fb78A6` | `@altananetwork/sdk@0.7.1` | `0x10b1f9306d2a03557471d90a8624e7f758757b736b44d1e25ef3eba83ed96812` | **no** | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` | `0xD7d36D66d2F1B608A0F943f722D27e3744f66F25` | `86400` s | `false` |
| `0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA` | `@bnbagent/sdk@0.5.5` | `0xe06798700c986d4387898a1dfde009d52c75f77c7d8dd1a3e179c02d5138cb9b` | yes | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` | `0xD7d36D66d2F1B608A0F943f722D27e3744f66F25` | `900` s | `true` |

Recorded outcome in `ops/manifests/network-97.json`: `status: "VERIFIED"`, `writeAllowed: true`, `declarationConflict: true`, `reasons: []`, `selectedPolicy: "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA"`.

Resolution rules, all in `packages/commerce/src/compatibility.ts`:

- Both declarations are probed; neither is privileged by name.
- A candidate is `compatible` only when its code hash matches the pin, the router whitelists it, its bound commerce and router match the expected deployment, and its dispute window is greater than zero.
- **Exactly one** compatible policy must be live. Zero or two is the refusal reason `expected exactly one live compatible policy, observed <n>`, and `writeAllowed` becomes `false`.
- `declarationConflict` stays `true` in the output whenever the two declared addresses differ, so the conflict remains visible after selection.
- The selected policy's `disputeWindowSeconds` is then load-bearing downstream: `prepareHire` refuses any job whose `expiredAt` does not exceed `now + disputeWindowSeconds`.

The conflict is also recorded declaratively in `packages/chain/src/manifest.ts`, where the chain-`97` policy entry is attributed to `@bnbagent/sdk@0.5.5 NETWORKS` alone while every other testnet role is attributed to both SDKs.

## Documented-versus-installed discrepancies

Each of these was found by comparing declarations against what is actually installed or recorded. None is hidden.

| # | Discrepancy | Status |
| --- | --- | --- |
| 1 | `@altananetwork/sdk` is an **optional** peer of `@bnbagent/sdk@0.5.5`, yet it is a hard direct dependency of the root workspace, because `packages/commerce/src/deployments.ts` reads `ERC8183_ADDRESSES` from it and `verifyTestnetCommerce` probes its declared policy | Intentional. Removing it would remove one side of the conflict check |
| 2 | The four seller workspaces do **not** install `@altananetwork/sdk` at all — the optional peer is left unsatisfied in their lockfiles — while the root does | Intentional. Sellers only need the `@bnbagent` side; no seller code reads the Altana registry |
| 3 | Two major lines of `zod` are live in one repository: `4.1.13` at the root, `3.25.76` in all four sellers | Accepted. The workspaces are separately installed, share no runtime and cannot import each other's schema modules. Separately, `evidence/claims.json` records under `service-request-intake-boundary` that the marketplace and seller schemas are not yet one canonical package |
| 4 | `@types/node` is `24.10.1` at the root and `22.20.1` in the sellers, matching engines `>=24` and `>=22` respectively | Accepted and consistent with the declared engines |
| 5 | `@bnbagent/sdk@0.5.6` is published and declares the identical `@altananetwork/sdk: 0.7.1` peer, and `@bnbagent/studio-runtime@0.0.14-alpha.*` prereleases exist | **Not measured.** Neither is installed. No claim is made about whether they preserve the ERC-8183 description encoding that `1180` exposed |
| 6 | `@altananetwork/sdk@0.8.0` and `0.9.0` are published but uninstallable under `@bnbagent/sdk@0.5.5`'s exact peer pin | Blocked upstream, not a repository choice |
| 7 | HealthGuard declares the `ai` package (`7.0.93`) and every seller image carries a model-credential path, but no analysis path calls a model: `buildRunWork()` in all four sellers returns a deterministic analyzer (`analyzeHealthGuardText`, `analyzeRangePilotText`, `analyzeGridQuantText`, `analyzeYieldScoutText`) | Accepted. The dependency is present and unused by the paid path. Buyer inputs are never sent to a model provider — see `PRIVACY.md` |
| 8 | The `rangepilot`, `gridquant` and `yieldscout` lockfiles are byte-identical; only HealthGuard's differs | Expected, given #7 |
| 9 | The `health` category is restricted to uncompressed `base64url` transport while the other three may use `deflate-base64url` | Intentional, enforced in `packages/contracts/src/service-request.ts` and in the `service_requests_transport_check` database constraint |
| 10 | `service_requests.task_description` permits 1–90,000 UTF-8 bytes, while the prepared description must also fit `MAX_ERC8183_DESCRIPTION_BYTES - 896`, and `verified_quotes.canonical_job_description` permits only 1–4,096 bytes | Accepted. The database bounds are outer envelopes; the binding limit is the application check. `MAX_ERC8183_DESCRIPTION_BYTES` is imported from `@bnbagent/sdk/erc8183` and is deliberately not restated as a literal anywhere in this repository, so its numeric value is not asserted here |
| 11 | The retained chain-recovery rollout record binds **seven** migrations; the source tree contains **twelve**, and the latest live capture (`evidence/operations/verified-quote-live-20260910.json`, release `80e3b45`) records `migrationCount: 12` | Known and already documented in `REPRODUCE.md`. The seven-migration count belongs to the older retained rollout, not to the current tree |
| 12 | Paid jobs `1187`, `1188` and `1189` predate mandatory request-id replay binding and are **intentionally rejected** by the current quote verifier | Deliberate. Recorded as a limitation on `owned-seller-quote-persistence-fence` in `evidence/claims.json` |
| 13 | `packages/chain/src/manifest.ts` attributes the chain-`56` policy `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` to both SDKs, but no runtime code cross-checks the two chain-`56` declarations — the compatibility probe runs only for chain `97` | **Unverified at runtime.** The chain-`56` agreement is a repository assertion. Stated as a gap in `THREAT_MODEL.md` |
| 14 | `@altananetwork/sdk` pulls `porto@0.2.37` and `@wagmi/core@3.6.5` into the root install, which in turn declare React, React Native and Expo optional peers | Accepted. All of those optional peers are uninstalled; no KNOT code imports them |
| 15 | ERC-1271 contract-signature verification is declared by the type system (`ERC1271_UNRESOLVED`, `signature_verification_basis = 'erc1271_pinned_block'`) but has no implementation | **Unimplemented.** Only EIP-191 EOA quotes are persisted. Recorded as a limitation in `evidence/claims.json` |

## Network and RPC endpoints

| Chain | Endpoints (`packages/chain/src/manifest.ts`) | Write-enabled |
| --- | --- | --- |
| `56` | `https://bsc-dataseed.bnbchain.org`, `https://bsc-dataseed1.defibit.io` | `false` |
| `97` | `https://data-seed-prebsc-1-s1.bnbchain.org:8545`, `https://bsc-testnet-dataseed.bnbchain.org` | `true` |

The chain-`97` ERC-8004 identity reader requires exactly these two endpoints, in this order, and refuses otherwise with `CONFIGURATION_MISMATCH`. Both sit under one domain owner, which is why `THREAT_MODEL.md` records that the dual-provider agreement check does not establish provider-operator independence.

Some evidence captures used a third public endpoint for their one-off reads: jobs `1180` and `1181` record `rpcUsed: "https://bsc-testnet-rpc.publicnode.com"`.

## ERC-8004 seller identities, chain `97`

All four are registered in registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, as pinned in `packages/discovery/src/public-sellers.ts`.

| Seller | Category | Agent id | Registered owner | Origin | Card name | OAuth scope |
| --- | --- | --- | --- | --- | --- | --- |
| HealthGuard | `health` | `2295` | `0xaf7474d06f171e6fd72fc5af114b34f3d5af8389` | `https://knot-health.truematchx.com` | `healthguard-agent` | `knot:healthguard:invoke` |
| RangePilot | `rebalancing` | `2297` | `0xe4fed886b4b9062486d4663c6962e14473bd7320` | `https://knot-range.truematchx.com` | `KNOT RangePilot` | `knot:rangepilot:invoke` |
| GridQuant | `grid` | `2298` | `0x3d5355a97352f4d078016342ad117a5e88d5c74f` | `https://knot-grid.truematchx.com` | `KNOT GridQuant` | `knot:gridquant:invoke` |
| YieldScout | `yield` | `2299` | `0x6fd04720c7fccb6dcebf6cf08dd6f5c764c7d8e3` | `https://knot-yield.truematchx.com` | `KNOT YieldScout` | `knot:yieldscout:invoke` |

Each card must declare A2A `protocolVersion: "0.3.0"` with `preferredTransport: "JSONRPC"`, expose both `negotiate` and `notify_funded` skills, carry an OAuth 2.0 client-credentials scheme whose token URL is `${origin}/oauth/token`, and publish a domain-registration proof binding exactly `eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e` with the expected agent id. The 8004scan index reported `is_verified=false` for `2297`, `2298` and `2299` even though each proof returned HTTP 200; that disagreement is published rather than reconciled.

## How to re-verify this matrix

```sh
npm ci
for seller in healthguard rangepilot gridquant yieldscout; do
  (cd "agents/$seller" && corepack pnpm install --frozen-lockfile)
done
npm run check
npm run manifest:verify
npm run sellers:verify:public
```

`npm run manifest:verify` performs live reads, rewrites `ops/manifests/network-56.json` and `ops/manifests/network-97.json`, and runs the chain-`97` commerce compatibility probe. Because it is a live read, results change with RPC availability and contract state; inspect the Git diff before retaining a new observation. A write-enabled network exits non-zero unless exactly one compatible live policy passes every check. Full command inventory is in `REPRODUCE.md`.

## Related documents

- `DECISIONS.md` — D3 and D4 explain why the conflict is resolved at runtime and why bytecode is pinned.
- `THREAT_MODEL.md` — what a proxy swap, a lying RPC or a drifted pin would mean.
- `REPRODUCE.md` — the complete reproduction command set.
