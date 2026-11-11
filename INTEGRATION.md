# SealedLaunch Phase 2: testnet integration

Date 2026-11-11, NEAR testnet only. Real OutLayer worker (project `deathstalker-sl.testnet/sealedlaunch`, build `607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6`, unchanged), real sale wasm built with `cargo near build`, embedded in the real factory, real `ref-finance-101.testnet`. All ids and tx hashes are in `deployments.json`. No git, GitHub or mainnet actions.

## Result

| Step | Outcome |
|---|---|
| Build sale wasm (`cargo near build non-reproducible-wasm --no-abi`) | 394,499 B, sha256 `20fae2f4...ab37` (final). The first one tested live was `5294bfb3...5a1b` |
| Embed in factory, deploy `sealedlaunch.deathstalker-sl.testnet` | OK. 608,377 B, `get_sale_code_hash` equals the sale sha |
| `create_sale` (factory -> keyless sale -> real OutLayer `derive_pubkey` -> `set_pubkey`) | OK twice. 79 Tgas used of 300 |
| Sale account has zero access keys (RPC `view_access_key_list`, `scripts/verify_keyless.sh`) | VERIFIED for both `sale-alpha` and `sale-beta`: 0 keys, checked right after create and again after settle |
| Bids ciphertext-encrypted with clearing-js `encryptBid` to the pk_sale the factory got from OutLayer | OK. 5 bids from 3 bidders (one bidder with 2 bids, one below-reserve bid that must drop) |
| `finalize` with the REAL worker | First attempt FAILED (mismatch 2 below). After the fix: worker output accepted, `on_clear` recomputed on chain and matched, status Cleared (`verified_onchain: true`) |
| Independent JS recompute (clearing-js `clear` from chain slots + revealed plaintexts) | Same p_star, sold, raise, alloc_root, leaf_count as on chain (`claims.mjs`) |
| `claim` x3 with Merkle proofs from JS | OK. Forged refund rejected ("invalid merkle proof"), second claim rejected ("already claimed"). Token balances and NEAR refunds correct |
| `settle` with real Ref LP | WORKED first time. Pool 2934 on `ref-finance-101.testnet`: 200 tokens + 5.05 wNEAR, 1e24 shares held by the keyless sale account, `lp_status = Done`, creator received 5.05 NEAR |
| `claim_vested`, `withdraw_fees` | Both OK (vested 27.67 tokens a few seconds after Cleared; fees 0.005 NEAR) |
| Liveness (`refund_all`) | Verified on `sale-alpha` with a real failed OutLayer run (see below). Not a literal never-answering worker |
| Live decryption-oracle check | A `clear` request sent straight to OutLayer from a bidder account was refused by the worker guard: `refused: predecessor 'dsl-bidder1.testnet' is not sale ...` |

Sale beta numbers: bids (price NEAR/token x tokens): b1 0.0120x400, b2 0.0110x400, b3 0.0101x300, b1 0.0101x100, b3 0.0050x100 (BelowReserve, dropped). P* = 0.0101, supply 1000 sold fully, raise 10.1 NEAR. Fills: b1 450, b2 400, b3 150 (marginal level split pro rata 300:100 over 200). Refunds b1 1.265, b2 1.36, b3 2.015 NEAR (includes the dropped 0.5 NEAR bid). The OutLayer run for 5 bids cost 0.001065 NEAR (32M instructions, 651 ms); `derive_pubkey` 0.001062 NEAR.

## Integration mismatches found and every change made

1. **Factory vs sale init/set_pubkey (found by reading, before deploy).** The factory called `init({p, creator})` and `set_pubkey({pk})`. The sale exposes `new({p: InitParams})` and `set_pubkey({pubkey})`, and `InitParams` has wiring fields (`creator`, `factory`, `outlayer`, `finalize_timeout_secs`, `recompute_cap`, `mode`, `reveal_secs`, `reveal_bond`, `pubkey`, `ref_exchange`, `wnear`) that SPEC `CreateParams` lacks.
   - Changed `contracts/factory/src/lib.rs`: calls `new`; new `init_args()` builds InitParams = CreateParams minus `name` plus wiring; `set_pubkey` sends `{"pubkey": pk}`.
   - New factory state field `defaults: SaleDefaults` (`finalize_timeout_secs` 3600, `recompute_cap` 200, `ref_exchange` ref-finance-101.testnet, `wnear` wrap.testnet), owner-only `set_sale_defaults`, view `get_sale_defaults`. `new()` signature unchanged.
   - Changed the factory test mock `tests/mocks/sale` (`new(p)`, `set_pubkey(pubkey)`) and `tests/sandbox.rs` (`pubkey` arg). Factory tests: 5/5 pass.
2. **Sale `finalize` input lacked `"action":"clear"` (found live).** The worker's `Input.action` is required, so the real run returned `{"error":"bad input: missing field action ..."}` and `on_clear` rejected it ("TEE run failed", retryable, as designed). The mock outlayer never parsed the input, so no test caught it.
   - Changed `contracts/sale/src/lib.rs`: add `"action": "clear"` to `input_data`. Sale tests: 16/16 pass (10 + 6). Sale wasm rebuilt, factory rebuilt and redeployed over the same account (state compatible, no re-init).
   - Because sale accounts are keyless, `sale-alpha` (built before the fix) could never be repaired. It became the failed-run/liveness case below.
3. Checked and found compatible, no change: worker output field names/formats (`sale_id, input_hash, code_hash, p_star, sold, burned, raise, alloc_root, leaf_count, plaintexts`), hex salts, decimal-string u128, `bid_end_ms` JSON number, `code_hash` echo, `input_hash` equality, factory `derive_pubkey` response `{"pubkey":...}`, worker derive guard allowing the factory as predecessor, `payer_account_id`, gas buffers (finalize prepaid 300 Tgas OK for 5 slots).

## Liveness path (sale-alpha)

Finalize was sent after bid_end; OutLayer returned a worker error (mismatch 2). `on_clear` rejected it and reset `in_flight` (status stays Clearing). After `bid_end + 420 s` `is_refund_mode` was true, `finalize` was refused ("finalize window passed: refund mode"), and `refund_all(0, 25)` returned all 5 deposits in one call (bidder balances back to about 10 NEAR minus fees and gas); a second `refund_all` returned 0. Bid fees (0.001 NEAR each) are not returned, as specified.
This exercised "run failed -> timeout -> refund". It did NOT exercise a worker that never responds at all (nothing to kill on OutLayer testnet from here); from the sale's side the state path after the deadline is the same, but the 10-minute `STALE_NS` re-finalize path was not run live.

## NEAR spent

Test accounts together went from 55.38 NEAR (deathstalker-sl.testnet 5.38 plus 5 faucet accounts of 10) to 50.16. The 5.22 difference is: 5.05 NEAR now wrapped inside the Ref pool (LP, held by the keyless beta sale), and about 0.17 NEAR gas, OutLayer fees and Ref storage deposits. Not "spent" but parked and not recoverable by key: factory 6.59 NEAR balance (6.09 is its storage; owner can `withdraw` only the surplus), `sale-alpha` 4.96 and `sale-beta` 4.84 NEAR (about 3.95 each is wasm storage; sale-alpha's remaining deposits were all refunded). A sale costs about 5.0 NEAR to create at the current 394 KB wasm size (`get_required_deposit` = 4.994 NEAR with a 1 NEAR buffer), which is the main cost lever for the demo; shrinking the sale wasm would cut it linearly. Faucet accounts used (free): `deathstalker-sl-2`, `deathstalker-sl-3`, `dsl-bidder1..3`. Only `deathstalker-sl.testnet` and these new accounts were used; no other credentials touched. Keys for the new accounts are in `~/.near-credentials/testnet/`.

## Not verified / caveats

- Not run live: NEP-141 payment path and Intents-style `ft_on_transfer`, fallback commit-reveal, `challenge`, `challenge_recompute`, the above-cap (>200 bids) Challenge path, `cancel_bid`, `top_up`, `retry_pk`, `retry_payout`. (Round 1 had only 5 bids; live runs with 16 to 100 bids were done later, see "Round 3" below.)
- Ref LP: pool price is not P*. `lp_tokens = floor(lp_funds*10^D/P*)` was 500 tokens but capped at `lp_token_reserve` (200), so the pool opened at about 0.025 NEAR/token versus P* 0.0101. LP shares sit in Ref under the keyless sale account with no withdraw path (intended: locked). If any step of the chain fails midway `lp_status = Failed` with no recovery; did not happen here.
- The `code_hash` in the worker output is only an echo; real binding is the OutLayer `--build` lock (unchanged, not re-tested here beyond the working run) and attestation. On-chain attestation verification still not done.
- The sale "OutLayer refund of unused deposit" destination was not traced; `finalize` was sent with 0.1 NEAR and OutLayer reported 0.0989 NEAR refunded.
- `claim_vested` and `withdraw_fees` were callable by the creator account; their access rules were not probed for other callers.
- Reproduce helpers: `contracts/factory/scripts/e2e/bids.mjs` (encrypt + place bids) and `claims.mjs` (recompute + Merkle proofs). They need a CJS bundle of clearing-js: `esbuild clearing-js/src/index.ts --bundle --format=cjs --platform=node --outfile=cj.cjs` next to them.

## Fixes round 2

Date 2026-11-11, testnet only. No git, GitHub or mainnet actions. Only `deathstalker-sl*.testnet`, `dsl-bidder*` and the factory account were used.

### Changes
1. **LP opens at P* (fixes the round 1 caveat above).** `settle` now sizes both sides together: `lp_funds = floor(raise*lp_bps/10000)`, `lp_tokens = min(lp_token_reserve, floor(lp_funds*10^D/p_star))`, then `lp_funds = min(lp_funds, floor(lp_tokens*p_star/10^D))`. A too-small reserve shrinks funds (remainder to the creator) instead of mispricing. Unused reserve is burned as before.
2. **Creation rule.** Factory `create_sale` and sale `new` require, when `lp_bps > 0`, `lp_token_reserve >= ceil(auction_supply*lp_bps/10000)`. This is exact: tokens needed are `sold*lp_bps/10000 <= auction_supply*lp_bps/10000` at any clearing price (raise has no upper bound, but needed tokens do), so the shrink path is a safety net that cannot trigger for validated sales. SPEC.md section 6 updated.
3. **Bid timestamps.** `Slot.ts` (ms, `env::block_timestamp_ms()` at bid time, also for `bid_commit`/`ft_on_transfer` bids). `get_bid` returns `ts: U64`; `get_revealed_bids` entries carry `ts: U64` too. `ts` is not part of `input_hash` or the TEE input, so the worker is unchanged. SPEC.md updated. Storage layout of `Slot` changed: only fresh sales (alpha/beta are old wasm and have no `ts`).
4. **Wasm size.** Not shrunk meaningfully: the crate already uses `opt-level="z"`, LTO, `panic="abort"` and `cargo near` runs wasm-opt. An extra `wasm-opt -Oz --converge` pass saved only 6 KB (1.6%), not applied. Sale wasm is 395,423 B (was 394,499). `get_required_deposit` = 5.004 NEAR.

### Tests (all green)
- Sale: 17 (7 in tests/ft_lp_bench.rs, 10 in tests/sale.rs). `settle_with_ref_lp_against_mocks` now parses the mock Ref `add_liquidity` amounts and asserts `funds == tokens*p_star`; new `init_rejects_lp_reserve_too_small_and_bids_carry_ts` asserts reserve 49 < 50 is rejected at init and `get_bid.ts` is within the expected block time.
- Factory: 5/5, `validation_and_deposit_checks` now also asserts a too-small `lp_token_reserve` is rejected.

### Live run: sale-gamma (real OutLayer worker 607df359..., real Ref)
- Factory redeployed over `sealedlaunch.deathstalker-sl.testnet` (tx `8U9X728Y...`), `get_sale_code_hash` = new sale sha `84068b3e...bfe670`.
- `create_sale` tx `7MzxF7w1...` (79.5 Tgas): sale `sale-gamma`, 0 access keys (RPC `view_access_key_list` = `[]` after create and after settle), pk installed. Params: supply 500, LP reserve 250 (the exact minimum for lp_bps 5000), creator 100, reserve 0.005 NEAR, 18 decimals.
- 7 bids from 3 bidders (one below reserve, dropped), ciphertexts to the OutLayer-derived pk. `get_bid(idx).ts` populated (e.g. 1794342151390 for slot 0).
- `finalize` (first attempt 2.3 Tgas, rejected "bidding still open" because I sent it a few seconds early; second tx `GscXdUwd...` OK): real worker, 44.6M instructions, 820 ms, charged 0.001082 NEAR. `on_clear` recomputed on chain and matched: `verified_onchain: true`, P* = 0.0102, sold 500, raise 5.1 NEAR. Independent JS recompute matched p_star and alloc_root.
- 3 claims OK, `settle` tx `6PyY1jBk...`: event `lp_funds 2.55 NEAR`, `lp_tokens 250`, `creator_funds 2.55`, `lp_done ok`; sale status Settled, `lp_status` Done.
- **Verified on chain, `ref-finance-101.testnet` pool 2935**: `[sale-gamma token, wrap.testnet]`, amounts `250000000000000000000` and `2550000000000000000000000`, i.e. 2.55 / 250 = 0.0102 NEAR/token = P* exactly (round 1 was 0.025 vs 0.0101). Shares 1e24 held by the keyless sale account. Zero keys.
- Not re-exercised this round (still covered only by sandbox/round 1): forged-claim/double-claim rejections, `claim_vested`, `withdraw_fees`, refund path.

### NEAR spent
Six project accounts together went from 33.77 to 26.18 NEAR (-7.60). Breakdown: 2.55 NEAR locked as wNEAR in the Ref pool; 4.86 NEAR now sits in the keyless `sale-gamma` account (about 4.0 is wasm storage; it is not recoverable by key); the rest (about 0.2) is gas, OutLayer fee (0.0011), bid fees (0.007, held by the sale) and Ref storage. The other 2.55 NEAR of raise went to the creator and the bidders paid 5.1 NEAR for tokens (internal transfers, not spent). The factory balance rose 0.044 NEAR (OutLayer refund of unused deposit).

### Notes
- The CLI output parse in `scripts/e2e/bids.mjs` did not capture bid tx hashes (`tx undefined`); they were recovered from nearblocks v3 (`/v3/accounts/<id>/txns`). `scripts/e2e/bids2.mjs` is the 7-bid variant used here; `cj.cjs` is the esbuild bundle (rebuild with the esbuild in `clearing-js/node_modules/.pnpm/esbuild@0.21.5`).
- Public RPC `rpc.testnet.near.org` now returns a deprecation notice; `rpc.testnet.fastnear.com` worked.

## Round 3: scale, sniper and attack runs (n-series)

Date 2026-11-11, testnet only, same factory and sale wasm as round 2 (`84068b3e...bfe670`), real OutLayer worker `607df359...`, real Ref. Driven by `scripts/src/launch-runner.ts`, `sniper-bot.ts` and `attack-suite.ts`. Full table, column definitions and failures: [`scripts/evidence/TABLE.md`](scripts/evidence/TABLE.md) and [`scripts/evidence/NOTES.md`](scripts/evidence/NOTES.md). Ids and lifecycle txs: `deployments.json` `sales.n10` ... `sales.n100`.

- Seven sales ran create (or resume) -> bids -> finalize with the real worker -> on-chain recompute -> claims -> settle with Ref LP: n30 (30 bids), n50 (39), n10 (60), n20b (16), n20c (44, bot only, not counted as evidence), n20d (69), n100 (100). Sale names are run tags, not bid counts.
- All 7 saved `verify` outputs: `RESULT: PASS (23 pass, 0 fail, 0 warn, 0 skip)`, with `sum(deposits) == raise + sum(refunds)` exact to the yocto.
- finalize->on_clear (chain time): 6.7 to 8.5 s in 6 of 7 runs (16 to 100 bids), 11.0 s for n30. OutLayer net cost about 0.001 NEAR per finalize at every size. Finalize gas 29 to 89 Tgas.
- Sniper simulation, one run per scenario, bots from one machine over public RPC (not one block): "first" (n10) and "last" (n20d) 50/50 landed, "split" (n100) 80/80. Every bot winner paid P*; bot and honest average prices identical; Spearman arrival vs fill +0.04 / +0.12, bid price vs fill +0.81 / +0.83. Two earlier attempts landed 0 of 50 (n50: RPC 429 and underfunded wallets; n20b: sent after the deadline and underfunded) and are recorded as failed runs.
- Attack suite on sale-n10 after clearing: 9 of 9 rows rejected as expected, 0 inconclusive (the tampered-claim rows that were INCONCLUSIVE on sale-beta reached the Merkle check here).

### New integration finding: finalize deposit (being fixed)

At 100 bids `finalize` with the flat 0.1 NEAR deposit failed inside OutLayer: `Insufficient payment: required 174530500000000000000000 yoctoNEAR (7000500000000000000000 for compute, 167530000000000000000000 held for 49521 bytes of input_data beyond the free 32768), got 100000000000000000000000` (tx `3h4JaX8NU7vCAffTB7wAkWMsRjFWkmDaCKRrAN7vWZjN`; the top-level finalize returned `false` and the sale stayed retryable). A second finalize with 0.5 NEAR inside the 420 s window cleared it (tx `Bxm8JevV474zfbuLTRCo2Eb4vLXQgYrxtPEWxhTaidCD`), net OutLayer charge about 0.001 NEAR. The round 1 note above ("finalize was sent with 0.1 NEAR") is only safe for small sales: OutLayer input grows about 1.4 KB per bid and only 32,768 B is free. The evidence runner used 0.5 NEAR for more than 40 bids as a workaround; deposit sizing in the contract, scripts and UI is being fixed separately and is not reflected in these runs.

### Other problems hit (recorded, not hidden)
- Public RPC rate limits (-429) were the main failure mode for parallel bots and bids.
- n100: `create_sale` returned "fetch failed" although the tx succeeded (`DQJmCGyxVEMjVmFZqfXkbZHYbTny95nhCFh2KVtWiZZh`); house-bid tx records were lost. Runner claims with 12 Tgas failed ("Exceeded the prepaid gas"); all 94 leaves were then claimed with 30 Tgas by `scripts/evidence/claimrest.mts`.
- Not run: a one-block bot burst, a 200-bid sale, live challenge / never-answering worker / malicious-TEE variants.
