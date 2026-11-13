# SealedLaunch research (10 Nov 2026)

Tags: **VERIFIED** = observed first-hand today (RPC view call, crate source, fetched doc page, local run). **UNVERIFIED** = inferred, from memory, or only seen in a search snippet.
Nothing was deployed, signed or spent. All chain access was read-only RPC.

## 1. Rhea / Ref Finance on testnet (answers §12 Q4)

**Verdict: yes, there is a live, usable testnet. Use it. Keep the built-in pool only as a fallback.**

| Fact | Status | Source |
|---|---|---|
| `ref-finance-101.testnet` exists, has code, `state: Running`, version `1.9.19`, 2,934 pools | VERIFIED | testnet RPC `view_account`, `metadata`, `get_number_of_pools` |
| Owner `reflabs.sputnikv2.testnet`; wNEAR is `wrap.testnet`; `admin_fee_bps` 2000 | VERIFIED | `metadata` view |
| Other candidates: `v2.ref-finance.testnet` does not exist; `exchange.ref-dev.testnet` exists but is an older deploy (not used) | VERIFIED | RPC |
| Pools are active; last pool is a `SIMPLE_POOL` of `wrap.testnet` + a user token, fee 30 bps, `amp: 0` | VERIFIED | `get_pool` |
| Exported methods in the deployed wasm include `add_simple_pool`, `add_liquidity`, `remove_liquidity`, `register_tokens`, `storage_deposit`, `withdraw`, `ft_on_transfer`, `mft_transfer_call`, `mft_balance_of`, `predict_add_simple_liquidity` | VERIFIED | strings from `view_code` of the contract |
| Method signatures: `add_simple_pool(tokens: Vec<AccountId>, fee: u32) -> u32` (payable, attach about 0.003 NEAR or more for storage; a tutorial used `fee: 30`); `add_liquidity(pool_id, amounts: Vec<U128>)` (needs 1 yoctoNEAR per the CLI guide); `storage_deposit(account_id, registration_only)`; `register_tokens(token_ids)` | VERIFIED for names and arg shapes (docs); exact deposit amounts UNVERIFIED | [Ref gitbook, ref-exchange](https://ref-finance.gitbook.io/ref-finance/smart-contracts/ref-exchange), [CLI usage](https://guide.ref.finance/developers-1/cli-trading) |
| Min storage deposit for a Ref account is 0.00102 NEAR (`storage_balance_bounds`: min `1020000000000000000000`) | VERIFIED | RPC view |
| Funding flow: pool tokens must first be **deposited into the Ref internal account** via `token.ft_transfer_call(ref-finance-101.testnet, amount, "")` (empty `msg`; Ref must be storage-registered on the token), and the depositor must be storage-registered on Ref and have called `register_tokens` | VERIFIED (docs + error strings `E11`, `E21`, `E22`, `E28`) | Ref gitbook page above |
| Token whitelist: deposit of a token that is neither globally whitelisted nor user-registered fails with `E12: token not whitelisted`. `wrap.testnet`, `usdc.fakes.testnet` etc. are globally whitelisted. Our memecoin is not, so the sale account must call `register_tokens([token])` itself | VERIFIED (error string + whitelist view); that `register_tokens` suffices for a custom token UNVERIFIED (not dry-run, because that needs a signed tx) | RPC `get_whitelisted_tokens`; wasm strings |
| First `add_liquidity` into an empty simple pool sets the price (the ratio of the two amounts). Error `E65: init token balance should be non-zero` implies both amounts must be non-zero | UNVERIFIED mechanism, plausible from the error string | wasm strings |
| LP shares are held in the Ref internal account of the provider. If the sale account has zero access keys and its code never calls `remove_liquidity` / `mft_transfer`, the shares are locked in practice. `get_pool_shares(pool_id, account_id)` is a view for the demo/verification | VERIFIED (method exists); locking is a design property, not a Ref feature | RPC / wasm exports |
| Source repo `github.com/ref-finance/ref-contracts` now returns 404 via the GitHub API (moved or private). We could not read the Rust source. Anything beyond the exported-method list above is from docs or error strings | VERIFIED (404) | `gh api` |

**Risk to design around: pool-creation front-running (UNVERIFIED but real).** `add_simple_pool` and the first `add_liquidity` are separate calls. A bot could add liquidity first at a skewed ratio. Mitigations: (a) do the two calls as one batched promise from the sale account, noting `pool_id` is the return value of the first call so the second must be a `.then` callback (still a different block); (b) after `add_liquidity`, view the pool and revert/alert if reserves do not match P\*; (c) make the pool token pair unguessable until `settle`, since the token account is public only after sale creation (weak). Pick (b) plus the callback chain and say so honestly in the README.

**Facts that matter for the LP step**
- Whitelist of `auto_whitelisted_postfix` in `metadata` lists `meme-cooking.testnet`, `.tkns.testnet`, `.tkndev.testnet`, `.portalpad1.testnet`. Tokens under those postfixes skip the whitelist. We cannot use them.
- Fee tiers seen on testnet: 20, 30, 40 bps. `E90: fee too large`, `E62: illegal fee` exist. UNVERIFIED which values are legal; use 30.
- Rhea branding: `rhea.testnet` exists but is an empty plain account (code hash all 1s), so Rhea has no separate testnet contract. "Rhea" on testnet is `ref-finance-101.testnet`. `docs.rhea.finance` did not resolve.

**Recommendation:** auto-LP into `ref-finance-101.testnet` as a **Should**. Budget about half a day. Keep a minimal constant-product fallback only if the first dry run fails by Day 3.

## 2. meme.cooking launch mechanics (answers §12 Q7)

Source: [docs.meme.cooking how-it-works](https://docs.meme.cooking/for-buyers/how-it-works), [create-a-token](https://docs.meme.cooking/for-cooks/create-a-token), live API `https://api.meme.cooking/meme` (VERIFIED, fetched).

| Question | Answer | Status |
|---|---|---|
| Single price? | **Yes, but not a quoted or limit price.** Everyone who deposits gets tokens pro-rata to their NEAR, so the effective price is `total_deposits / distributed_supply`, known only when the countdown ends. Docs: "every depositor buys at the same price" | VERIFIED (docs; no formula given) |
| Price discovery / limit bids? | None. A buyer only chooses an amount to deposit | VERIFIED |
| Duration | Creator-set, 5 minutes to 1 day | VERIFIED |
| Caps | **Soft cap** (minimum NEAR; below it the token does not launch and depositors must withdraw manually) and optional **hard cap** (reaching it launches immediately). Example live meme: soft cap 100 NEAR, hard cap 500 NEAR (`wrap.near` as deposit token). No per-wallet min/max stated | VERIFIED |
| Deposits public? | **Yes.** Anyone can see totals live; API returns `total_deposit`, `total_deposit_fees`, `total_withdraw_fees` per meme | VERIFIED |
| Withdraw during sale | Allowed, with a **2% early-withdrawal fee** shared among those still in at the end (docs also mention a 0.5% refund fee in one example and do not reconcile it) | VERIFIED (docs inconsistent) |
| Liquidity | Deposited NEAR (minus protocol fee) plus about 50% of the distributed supply go into a **Ref Finance pool at the auction's price. LP locked for 69 years.** Launch requires at least 4k NEAR deposited (per the intro page) | VERIFIED (docs; the 4k threshold conflicts with the 100 NEAR soft cap on the live meme, so treat it as UNVERIFIED) |
| Team allocation | Optional percentage of supply with cliff and linear vesting (live example: 20% of supply, 7-day cliff, 21-day vesting) | VERIFIED |
| Claiming | Depositors claim tokens manually after launch | VERIFIED |
| Supply | Fixed 1B tokens, 18 decimals in the sample | VERIFIED (one sample) |

**How to pitch against it:** meme.cooking is a **pro-rata, public-deposit, soft-cap pool**. Our differences are real: sealed limit bids (a buyer states a max price), a clearing price set by the demand curve instead of by whoever deposits last, no live deposit totals to chase, and an on-chain-recomputable allocation. Drop "no price discovery" as a blanket claim: they do have a single price, it is just implied by total deposits. Correct §4's "from memory" row, which currently says pro-rata at one price (right), public deposits (right), and does not mention the hard/soft cap or the 69-year LP lock.

## 3. Versions (checked 10 Nov 2026)

| Tool | Version | Status / notes | Source |
|---|---|---|---|
| **near-sdk-rs** | **5.30.1** (2026-11-04). Edition 2024, `rust-version = "1.95"`. Declares nearcore 2.14 / protocol 88. Local rustc is 1.96.0, OK | VERIFIED | crates.io API, downloaded crate `Cargo.toml` |
| near-contract-standards (NEP-141 reference impl) | **5.30.1**, depends on `near-sdk ~5.30.1`. Use `FungibleToken` + `FungibleTokenCore/Resolver/StorageManagement` (the template in the near-sdk-rs repo `examples/fungible-token`). Pin both to the same patch version | VERIFIED (version and dep); API names from memory, UNVERIFIED | crates.io |
| **cargo-near** | **0.23.0** (2026-11-06). Installed locally as `cargo-near-near 0.23.0`. Subcommands: `new`, `build`, `abi`, `check`, `create-dev-account`, `deploy` | VERIFIED | crates.io, `cargo near --help` |
| **near-workspaces** (Rust) | **0.24.0** (2026-10-26). Uses `near-sandbox ^0.4`, `near-sdk ^5.26` | VERIFIED. **Our run failed: the sandbox binary download timed out (`DownloadError("timeout: connect")`) inside this shell's network sandbox.** Run integration tests on a machine with network access, or pre-download `near-sandbox`. | crates.io; local run |
| near-sandbox (npm) | 0.3.5 | VERIFIED | npm |
| **near-api-js** | **7.4.0** (latest, 2026-10-23). Dist-tags: `rc 7.0.0-rc.7`, `preview 0.28.0-preview`. Deps are `@noble/*`, `borsh 2.0.0`; it is the maintained package, with modules re-exported | VERIFIED | `npm view` |
| `@near-js/accounts` / `@near-js/client` | **2.5.1** (published Nov 2025) | VERIFIED. Prefer `near-api-js@7` (one package); only use `@near-js/*` split packages if bundle size matters | npm |
| near-api (Rust) | 0.8.7 (not needed) | VERIFIED | crates.io |
| near-cli-rs | 0.31.1 | VERIFIED | npm/crates |
| **eciesjs** | npm latest **0.5.0** (3 Apr 2026). The spike `spike-outlayer/client/package.json` pins `^0.4.15` (0.4.18 is the latest 0.4.x) | VERIFIED. **Whether 0.5.0 changed wire format or defaults vs 0.4.x is UNVERIFIED.** Pin the exact version on both browser and TEE sides (a Rust `ecies` crate must match the same ECIES layout) and keep the spike's 0.4.x unless you test 0.5.0 round-trip against the WASM | npm |
| OutLayer docs site | moved to `app.outlayer.ai/docs` (the `outlayer.fastnear.com` URL 301s) | VERIFIED | fetch |

### promise_yield_create / yield_resume in near-sdk-rs 5.30.1 (VERIFIED from crate source)

- **High-level:** `Promise::new_yield(function_name: &str, arguments: impl AsRef<[u8]>, gas: Gas, weight: GasWeight) -> (Promise, YieldId)` (added in 5.23.0). The returned promise must come first in a chain (`other.then(yielded)` panics). Return it from the method so the caller receives the callback's result.
- **Resume:** `YieldId::resume(self, data: impl AsRef<[u8]>) -> Result<(), ResumeError>`. `Err` means not found, already resumed, or timed out. `YieldId` is a 32-byte hash, borsh- and JSON-serialisable (base64 in JSON), so store it in contract state.
- **Callback:** a `#[private]` method taking `#[callback_result] r: Result<T, PromiseError>`. On resume it gets `Ok(payload)`, on timeout `Err(PromiseError::Failed)`. Docs example uses `Gas::from_tgas(5)` for the callback; give more if the callback does the recompute (see §4). Source: [docs.near.org yield/resume](https://docs.near.org/smart-contracts/anatomy/yield-resume).
- **Low-level:** `env::promise_yield_create`, `env::promise_yield_create_id`, `env::promise_yield_resume`.
- **New in 5.29+ (protocol 85+):** `Promise::new_yield_with_id(..., deposit: NearToken, ..., UserYieldId) -> Option<Promise>` and `UserYieldId::resume`. You choose the 32-byte id (for example `sha256(sale_id)`), so the resumer can derive it without reading state. Returns `None` if the same id is already pending, which gives a free "one pending clearing per sale" guard.
- **Timeout: 200 blocks** (`yield_timeout_length_in_blocks = 200`), roughly 3 to 4 minutes at about 1 s per block. VERIFIED on both testnet and mainnet protocol config (protocol 88). **This is far shorter than a 24h bid window or a long TEE run.** The yield only starts at `finalize`, so it needs to outlast OutLayer's run, up to its 180 s max execution plus queueing. Tight. Design `finalize` to be retryable and `refund_all`/`retry` on timeout.
- **Payload limit: `max_yield_payload_size = 1024` bytes.** VERIFIED (testnet and mainnet RPC `EXPERIMENTAL_protocol_config`).

### Important correction to the OutLayer plan (§2 step 3, §8)

1. **OutLayer returns through a normal `.then()` callback, not through our own yield/resume.** The docs example is a `#[private]` method reading `env::promise_result(0)`; `request_execution` is called from our contract and the result arrives as that promise's result (VERIFIED, [OutLayer near-integration docs](https://app.outlayer.ai/docs/near-integration)). OutLayer may use yield internally (UNVERIFIED). So our contract does not call `yield_resume` for this path; it calls `request_execution(...).then(on_clear)`. Keep `Promise::new_yield` only if we want our own wrapper timeout.
2. **Output cap: WASM stdout must be at most 900 bytes** per OutLayer's WASI page (VERIFIED on that page, "NEAR limit"); this matches the 1024-byte yield payload limit. **The TEE therefore cannot return "all decrypted bids" in the callback.** 200 bids at about 100 bytes each is 20 KB.
3. **Fix:** return only `{p_star, alloc_root, input_hash, n_valid, plaintexts_hash}` (under 900 B). Then plaintext reveal happens in a separate permissionless step: `reveal(Vec<Plaintext>)` called by anyone (TEE operator, bidders, a watcher) with batches. The contract checks each against `commit`, ignores duplicates, and after all bids are covered (or a deadline passes) recomputes `P*` and compares to the attested `p_star`. Plaintext bytes per bid: price 16 + size 16 + salt 32 + index 4 = 68 B, so 200 bids is about 14 KB, well under the 4 MB argument limit and 1.5 MB tx limit.
4. The TEE can also publish plaintexts to IPFS or HTTPS for the verify script; the chain does not need them from the TEE.

Other OutLayer facts (VERIFIED from the same docs): `request_execution(source, resource_limits, input_data, secrets_ref, response_format, payer_account_id, params)`; `resource_limits` must always be passed (even `{}`); defaults 1B instructions / 128 MB / 60 s; maximums 500B instructions / 4096 MB / 180 s; `input_data` is a JSON string read from stdin, with an extra 0.00001 NEAR per byte above 32 KB (refundable); the cost formula is base + instructions + milliseconds; `estimate_execution_cost(resource_limits, input_len)` is available as a view; unused deposit refunds to `payer_account_id`. TDX attestation is viewable in the UI, but **no on-chain programmatic verification is documented** (spike Q3 stays open; assume `predecessor == outlayer.testnet` only).

## 4. Gas and limits for on-chain recompute of about 200 bids (answers §12 Q3)

**Protocol limits, VERIFIED from `EXPERIMENTAL_protocol_config` on testnet and mainnet (both protocol 88):**

| Limit | Value |
|---|---|
| `max_total_prepaid_gas` / `max_gas_burnt` | **1,000 Tgas (1 PGas)** (the old 300 Tgas figure in docs is out of date for protocol 88). Still design for 300 Tgas per call; keep margin and do not assume other wallets or `near-cli` attach more |
| yield timeout / payload | 200 blocks / 1,024 bytes |
| `max_arguments_length` | 4 MiB |
| `max_transaction_size` / `max_receipt_size` | 1.5 MiB / 4 MiB |
| `max_length_returned_data` | 4 MiB |
| `max_number_logs` / `max_total_log_length` | 100 / 16 KiB |
| `regular_op_cost` | 822,756 gas per wasm op (about 1.2M ops per Tgas) |

**Measured today (local, partial): clearing compute only.** I compiled the existing `clearing/` crate (no changes) into a wasm module and ran it under `wasmi` with fuel metering, generating N bids with distinct prices/sizes and running `clear()` (commit verification with `sha2` in wasm, validate, sort, uniform-price scan, pro-rata, Merkle root). Fuel counts wasmi instructions, a rough proxy for nearcore's per-op charging:

| N bids | wasmi instructions (clear only) | approx Tgas at 822,756 gas/op |
|---|---|---|
| 10 | 0.27 M | 0.22 |
| 50 | 2.0 M | 1.7 |
| 100 | 4.0 M | 3.3 |
| 200 | 7.9 M | 6.5 |

Scaling is near-linear. At 2x for the proxy error (nearcore meters a stack machine) this is about **13 Tgas for 200 bids**. Not measured: JSON/borsh decoding of args, storage reads of the stored commits/deposits (about 56 Ggas base per `storage_read` plus per-byte, so 200 reads is about 11 to 15 Tgas), the 400-bid case (my harness hit a trap, not investigated), and the real sandbox gas. **UNVERIFIED end to end.** The sandbox run failed because `near-sandbox` could not download its binary (network blocked in this shell).
Harness and contract are in the session scratchpad: `/private/tmp/claude-504/-Users-devaf-woerk-near-hackathon-3/88b128ef-cb71-4f0c-be82-ae060bfee74e/scratchpad/bench/` (`contract/` is a near-sdk wrapper for near-workspaces, `pure/` + `fuel/` is the wasmi harness that produced the table).

**Conclusion:** gas is not the binding constraint for 200 bids; the **1,024-byte yield payload and 900-byte OutLayer output cap are**. Realistic budget for the whole recompute transaction at N=200 is about 30 to 50 Tgas including state reads, well below even a 300 Tgas cap. Cap per sale at 200 for sandbox-benchmark honesty; raising to 500 to 1,000 looks feasible but needs the near-workspaces run on a networked machine. Prefer `env::sha256` (host function) over `sha2` in wasm for commit hashing; it would shave most of the cost. If `reveal` batches span several transactions, the final `compute_clearing` call reads all stored plaintexts, which dominates.

## 5. Recommendations

1. **Rhea LP: go.** Target `ref-finance-101.testnet` with `wrap.testnet` as the quote token (NEAR bids wrap via `wrap.testnet`). Steps: sale `storage_deposit` on Ref, `register_tokens` for the memecoin and wNEAR, `ft_transfer_call` both tokens to Ref, `add_simple_pool` (fee 30), `add_liquidity(pool_id, [amount_a, amount_b])`, verify with `get_pool`. Run it by hand once on testnet before writing contract code, to confirm deposit amounts and that a non-whitelisted token works after `register_tokens` (UNVERIFIED). Drop the built-in pool fallback unless this fails.
2. **Change the clearing return design.** TEE returns only a hash/summary (at most 900 B); plaintexts arrive via a permissionless `reveal` call; the contract recomputes P\* on-chain. Update the original design doc (since removed from the repo): §2 steps 3 to 5, §7 `on_clear`, and §6 #3. Remove the claim that OutLayer's result "comes back by `yield_resume`"; it comes back through a `.then` callback.
3. **Keep the 200-block yield timeout in mind.** It is only usable around `finalize`, not around the 24h bid window. Use `UserYieldId` (`sha256(sale_id)`) if you want a single pending clearing, or skip yield and use the `.then` callback plus a stored `finalize_started_at` and `retry_finalize`/`refund_all` after `deadline + T`.
4. **Pitch vs meme.cooking:** accurate version above (pro-rata, public totals, soft/hard cap, 2% early-withdraw fee, 69-year Ref LP lock). Do not say "no single price".
5. **Pins:** `near-sdk = "=5.30.1"`, `near-contract-standards = "=5.30.1"`, cargo-near 0.23.0, near-workspaces 0.24.0, near-api-js 7.4.0, `eciesjs` pinned to the spike's 0.4.x unless a 0.5.0 round-trip against the WASM is tested. Build with `cargo near build` (a plain `cargo build --target wasm32-unknown-unknown` with Rust 1.96 may emit wasm features nearcore rejects; UNVERIFIED, I did not deploy).
6. **Open items still needing a networked machine or a signed tx:** near-workspaces gas numbers; dry-run of `add_simple_pool` + `add_liquidity` with a custom token; OutLayer attestation on-chain verification (spike Q3); mainnet `meme.cooking` contract id and its exact pricing function.
