# contracts/sale: status notes

Standalone crate `sealed-sale` (near-sdk =5.30.1, near-contract-standards =5.30.1, path dep `../../clearing`). Sale and NEP-141 token are the same account. Last refreshed 2026-11-11 against the current code (`src/lib.rs`, `src/lp.rs`) and `INTEGRATION.md` / `deployments.json`.

Two kinds of evidence are kept apart below: **sandbox** (near-workspaces 0.24.0 on this machine, mocks for OutLayer/Ref/wNEAR) and **live testnet** (real `outlayer.testnet`, real `ref-finance-101.testnet`, transactions listed in `deployments.json`).

## Build

- `cargo build --target wasm32-unknown-unknown --release` -> plain wasm used by the sandbox tests.
- `cargo near build non-reproducible-wasm --no-abi` -> `target/near/sealed_sale.wasm`, about 395 KB. This is the wasm embedded in the factory and deployed live.
- Sale wasm sha256 by generation: `5294bfb3...b5a1b` (sale-alpha, pre-fix), `20fae2f4...ab37` (sale-beta), `84068b3e...bfe670` (sale-gamma, current; has `Slot.ts` and p_star-exact LP sizing). Full hashes in `deployments.json`.
- Mock for tests: `mock-outlayer/` (separate crate, build it with the same wasm command before `cargo test`). It plays outlayer, Ref, wNEAR and a NEP-141 payment token. Test-only.
- Run: `cargo build --target wasm32-unknown-unknown --release && (cd mock-outlayer && cargo build --target wasm32-unknown-unknown --release) && cargo test`.

## Implemented

- `new(InitParams)`: CreateParams fields plus wiring (`creator`, `factory`, `outlayer`, `finalize_timeout_secs`, `recompute_cap`, `mode`, `reveal_secs`, `reveal_bond`, `pubkey`, `ref_exchange`, `wnear`). Mints auction + LP reserve + creator supply to the sale account. `outlayer_project` (`deathstalker-sl.testnet/sealedlaunch`) and `code_hash` (`607df359...`) are init params. `set_pubkey` (factory only, once). Live factory defaults: `finalize_timeout_secs` 420, `recompute_cap` 200.
- **Creation rule**: when `lp_bps > 0`, `lp_token_reserve >= ceil(auction_supply * lp_bps / 10000)` (also enforced by the factory). Tokens needed for the pool are `sold * lp_bps / 10000 <= auction_supply * lp_bps / 10000` at any clearing price, so the reserve always suffices.
- `bid` (NEAR), `ft_on_transfer`, `cancel_bid`, `top_up` (NEAR only), `finalize`, `on_clear`, `challenge`, `challenge_recompute` (extra), `claim`, `refund`, `refund_all` (batch of up to 25), `retry_payout` (extra), `settle`, `claim_vested`, `withdraw_fees` (extra), SPEC section 6 views plus `bid_status`, `is_claimed`, `finalize_gas_needed`.
- **`Slot.ts`** (ms, `env::block_timestamp_ms()` at bid time; set for `bid`, `bid_commit` and `ft_on_transfer` bids). `get_bid` returns `ts: U64`, `get_revealed_bids` entries carry `ts: U64`. `ts` is not part of `input_hash` or the TEE input, so the worker is unchanged. It feeds the sniper board (when each account bid). Only sales created from the round-2 wasm (`84068b3e...`, i.e. sale-gamma and later) have it; sale-alpha/beta predate it, and `scripts verify` accepts both shapes.
- `finalize`: `input_data` is `{"action":"clear","params":{sale_id,supply,reserve,token_decimals,min_size,bid_end_ms,code_hash},"entries":[{bidder,commit,deposit,ciphertext}]}`, built only from contract state. The `"action":"clear"` key was missing in the first build (the worker rejected the run); fixed in the `20fae2f4` wasm. `max_instructions = 3e9 + 2e9 * ceil(n/100)`, `payer_account_id` = finalizer, `secrets_ref.account_id` = project owner prefix, gas buffer sized from payload length (20 Tgas + 0.6 Ggas/byte). Zero bids: cleared on-chain without calling OutLayer.
- `on_clear` (`#[private]`, non-panicking so `in_flight` always resets): a failed run (promise failure, `null`, non-object, any `"error"` key, no `p_star`) is rejected and `finalize` can be retried until `bid_end + finalize_timeout`. Checks: nonce (stale callbacks), `sale_id`, `input_hash` against the stored slots, plaintexts length, deadline. The worker's `code_hash` echo is compared only when present (sanity, not proof). Trust in the worker comes from the OutLayer `--build` lock plus the fact that the callback only exists as the `.then` of our own call to `cfg.outlayer`. **It does not check the project id** (the OutLayer result does not carry it) and **does not verify any TDX attestation**.
- On-chain recompute: slots <= `recompute_cap` (max 200): `sealed_clearing::clear` is re-run and p_star, sold, burned, raise, alloc_root, leaf_count, input_hash must equal the TEE output, else rejected. Above the cap: status Challenge for `challenge_secs`, then lazily Cleared on the next `claim`/`settle`/`claim_vested`.
- `challenge(idx,price,size,salt)` voids the sale (Refund mode) if the revealed bid matches the stored commit, is valid and funded, and the TEE's published plaintext for that slot differs. `challenge_recompute()`: anyone recomputes from the published plaintexts at any slot count and voids if the posted result differs.
- `claim`: Merkle proof against `alloc_root`/`leaf_count`, once per bidder, anyone may submit, refund paid in the payment token. Payout failures are credited to `failed_payouts` and re-sent with `retry_payout`.
- Refund mode (void, or `bid_end + T` with no cleared result): `refund(idx)` / `refund_all`. Deposit + bond returned in full, bid fee not returned.
- **`settle` LP sizing rule** (integer math, in `settle`): `lp_funds = floor(raise * lp_bps / 10000)`; `lp_tokens = min(lp_token_reserve, floor(lp_funds * 10^D / p_star))`; then `lp_funds = min(lp_funds, floor(lp_tokens * p_star / 10^D))`. Both sides are sized together so the pool opens at `p_star` (to integer rounding). If the reserve were too small, funds shrink (remainder to the creator) instead of mispricing; with the creation rule this cannot trigger. `burned` plus the unused LP reserve (`reserve - lp_tokens`) are burned; `raise - lp_funds` goes to the creator; creator vesting is linear from Cleared. `withdraw_fees` runs after Settled/Refund and never touches escrow or the storage reserve.
- LP chain (`src/lp.rs`): wrap NEAR if needed, storage-register on the quote token and Ref, `register_tokens`, push both tokens to Ref with `ft_transfer_call`, `add_simple_pool(fee 30)`, `add_liquidity`, then `lp_status` Done/Failed.
- **`ft_on_transfer` (Intents-style NEP-141 path)**: never panics, makes no cross-contract calls, returns `U128(0)` for the payment token. `msg` is JSON text or base64url(JSON), max 1024 chars, `{v, sale_id, ciphertext, commit, bidder, refund_to}`; `bidder` defaults to `sender_id` (so a Verifier/relayer deposit can bid for a NEAR account named in msg). A transfer from any other token is returned in full. Anything not turned into a bid (malformed, wrong sale_id, bad bidder, duplicate commit, late, not above fee, max_bids) is stored as `Unclaimed` keyed by sha256(sender, token, msg) and pulled back with `claim_refund(sender_id, token, raw_msg, to)` (paid to the NEAR account in msg if parseable, otherwise only `sender_id`). `bid_status(commit)` returns accepted / unclaimed / unknown. Duplicate commits are rejected for NEAR bids too. `top_up` over NEP-141 is not available.
- Fallback commit-reveal behind the same `claim`: `bid_commit`, `reveal`, `clear`, `slash_unrevealed`. NEAR-only.

## Verified live on testnet (real OutLayer worker, real Ref)

Source: `INTEGRATION.md`, `deployments.json`; reproduced on 2026-11-11 with `pnpm verify` (see root README).

| Item | Where | Evidence |
|---|---|---|
| Factory creates a keyless sale, real `derive_pubkey`, `set_pubkey` | sale-alpha, beta, gamma | 0 access keys via RPC after create and after settle; create txs in `deployments.json` |
| `finalize` with the real worker, `on_clear` recompute on chain, status Cleared | sale-beta (5 bids), sale-gamma (7 bids) | `verify_onchain` true; independent JS recompute equal; `pnpm verify` PASS |
| `claim` with Merkle proofs, forged proof rejected, second claim rejected | sale-beta | txs `claim_forged_rejected`, `claim_twice_rejected` |
| `settle` with real Ref LP, `lp_status` Done | beta (pool 2934, opened at about 0.025 NEAR/token vs P* 0.0101: old sizing, mispriced), gamma (pool 2935, 2.55 NEAR / 250 tokens = 0.0102 = P* exactly) | Ref pool amounts read from chain |
| `claim_vested`, `withdraw_fees` | sale-beta | txs in `deployments.json`; access rules for other callers not probed |
| `Slot.ts` populated | sale-gamma | `get_bid(idx).ts` set |
| Failed worker run -> `on_clear` rejects -> timeout -> Refund mode -> `refund_all` | sale-alpha | `refund_all` returned all 5 deposits; second call returned 0; `finalize` after window rejected |
| Decryption-oracle guard (worker refuses a `clear` from a non-sale predecessor) | sale-alpha | tx `oracle_attack_refused_by_worker_guard` |
| `finalize` too early rejected | sale-gamma | tx `finalize_too_early_rejected` |
| Live attack suite against sale-beta | see `scripts/evidence/` | forged `on_clear` rejected, steal-via-name-swap rejected, double claim rejected, late bid rejected, refund outside refund mode rejected; 3 tampered-proof variants INCONCLUSIVE (rejected earlier by "already claimed") |

## Sandbox only (not exercised live)

- NEP-141 payment path and Intents-style `ft_on_transfer` (`intents_style_ft_path_never_rejects_and_unclaimed_pull`: 6 bad transfers become Unclaimed without revert, a good base64url bid is accepted, pull-back works). **No real Intents/1Click deposit has ever reached this contract**; Intents has no testnet and the 1Click `customRecipientMsg` path is untested end to end (see INTENTS.md).
- Fallback commit-reveal (`fallback_commit_reveal`), `challenge`, `challenge_recompute`, the above-cap Challenge path, `cancel_bid`, `top_up`, `retry_pk`, `retry_payout`.
- More than 7 bids: gas numbers below are sandbox with a mock OutLayer.

## Tests (near-workspaces sandbox)

`tests/sale.rs` (10) and `tests/ft_lp_bench.rs` (7, including bench), 17 in total after the round-2 changes (last run recorded in INTEGRATION.md "Tests (all green)"; not re-run for this refresh). Coverage vs SEALED_LAUNCH section 9: forged `on_clear` (private method), replay A->B, wrong code hash echo, tampered P*/root/input_hash/swapped plaintext, TEE `null`/`{"error"}`, mismatched/underfunded/garbage ciphertext dropped and fully refunded, false drop voided by `challenge`, TEE never answers, claim twice/forged proof, keyless account, Intents-style transfers, LP chain (asserts `funds == tokens * p_star` against the mock Ref), and `init_rejects_lp_reserve_too_small_and_bids_carry_ts`.

## Gas benchmark (sandbox, NEP-141 payment path, distinct bidders, mock OutLayer)

| N | on_clear gas used (recompute, to end of fn) | on_clear receipt gas_burnt | finalize receipt gas_burnt | tx total gas_burnt |
|---|---|---|---|---|
| 50 | 15.0 Tgas | 20.6 Tgas | 18.2 Tgas | 43.3 Tgas |
| 100 | 28.9 Tgas | 39.1 Tgas | 33.4 Tgas | 79.2 Tgas |
| 200 | 56.9 Tgas | 76.2 Tgas | 63.8 Tgas | 151.2 Tgas |

- Store-only path (cap 0, N=200): on_clear 45.4 Tgas burnt; `challenge_recompute` (N=200) 53.1 Tgas.
- Finalize costs about 0.32 Tgas per slot, so N=200 needs about 240 Tgas prepaid (`finalize_gas_needed` view). Unverified against payload variation (ciphertexts here were 161 B).
- **RECOMPUTE_CAP_MAX = 200.** Not measured above 200. The mock does no real work, so OutLayer's own gas share (spike: 3-5 Tgas burnt) is not in these numbers. Live runs only used 5 and 7 slots.
- A callback that runs out of gas reverts and leaves `in_flight` set; finalize can be re-issued after 10 minutes (`STALE_NS`). Happened once in the benchmark with too-small constants, which were raised. The 10-minute path was not run live.

## Known gaps and caveats

- Ref LP failure midway: `lp_status = Failed`, funds already moved stay where they are, no recovery path. Did not happen live. LP needs the sale balance to cover about 0.2 NEAR of Ref storage costs, which the sale's own balance (bid fees plus factory funding) pays.
- sale-beta's pool (2934) opened at the wrong price (old sizing). Fixed for sales created from wasm `84068b3e...`; beta is keyless and cannot be repaired.
- The unclaimed record has no storage payer (grief vector: small malformed transfers each cost the sale about 0.002 NEAR). Not mitigated.
- Return types: `claim`, `settle`, `refund`, `cancel_bid`, `reveal` return `PromiseOrValue<bool>` instead of `Promise`. `settle` cannot return a joint promise, so the creator payout is returned and the LP chain runs independently.
- Slot storage staking for revealed plaintexts is paid from the contract balance; `withdraw_fees` keeps the storage reserve plus 0.1 NEAR.
- No yield timeout path: `finalize` is a normal promise chain (SPEC v1.1).
- Cancelled slots keep `bidder` and a zero `commit` in the `input_hash` entries; the worker treats an empty ciphertext as `null`.
- Sandbox timing uses `fast_forward`; live testnet timing was only exercised on the 5-7 bid runs.
- A sale costs about 5.0 NEAR to create (wasm storage), mostly locked in the keyless account.
