# SealedLaunch testnet evidence table

All runs on NEAR testnet, 2026-11-11, real OutLayer worker (build `607df359...`), real Ref Finance, factory `sealedlaunch.deathstalker-sl.testnet`, sale wasm `84068b3e...bfe670` (all 7 sales, checked by `verify`). Every bidder wallet (house and bot) is our own testnet account; there were no outside bidders.

Sources: `sale-<name>...json` (written by `scripts/src/launch-runner.ts`), `sniper-*.json` (written by `scripts/src/sniper-bot.ts`), `verify-<sale>.txt` (saved `pnpm verify` output), `attacks-sale-n10...{bidding-window,cleared}.{md,json}` (written by `scripts/src/attack-suite.ts`). Run notes and failures: [`NOTES.md`](NOTES.md).

## Sale names do not match bid counts

The `nXX` in a sale name is the tag chosen before the run, not the number of bids. `sale-n10` has 60 bids, `sale-n50` has 39. `n20b`, `n20c`, `n20d` are retries (the name `sale-n20` was taken by an abandoned sale that settled with 0 bids). Use the `bids on chain` column, which is the contract's `bid_count`.

## Launch runs (7 sales)

| sale | scenario | bids on chain (house + bot) | bidders (leaves) | P* (NEAR/token) | fill % | raise (NEAR) | LP funds (NEAR) / tokens | burn (tokens) | finalize->on_clear (s) | finalize gas (Tgas) | runner gas total (Tgas) / cost (NEAR), see below | OutLayer net (NEAR) | refund correctness (from `verify-<sale>.txt`) | verify |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sale-n30 | house only | 30 (30 + 0) | 8 | 0.000200 | 80 | 0.160000 | 0.080000 / 400 | 301 | 10.958 | 34.58 | 210.84 / 0.021084 [B F C S] | 0.000987 | deposits 0.3144011892 = raise 0.16 + refunds 0.1544011892, diff 0 yocto | PASS 23/23 |
| sale-n50 | house only (50 planned, 39 landed); sniper "first" attempt here landed 0/50 | 39 (39 + 0) | 10 | 0.000384 | 100 | 0.384000 | 0.192000 / 500 | 1 | 7.252 | 41.08 | 252.972 / 0.025297 [B F C S] | 0.001000 | deposits 0.794976 = raise 0.384 + refunds 0.410976, diff 0 yocto | PASS 23/23 |
| sale-n10 | sniper "first" + house | 60 (10 + 50) | 60 | 0.000261 | 100 | 0.260752 | 0.130376 / 500 | 1 | 6.839 | 58.32 | 565.553 / 0.056555 [K B F C S], bot bids excluded | 0.001002 | deposits 0.533683625732 = raise 0.260752454 + refunds 0.272931171732, diff 0 yocto | PASS 23/23 |
| sale-n20b | house only (16 of 20 landed); sniper "last" attempt here landed 0/50 | 16 (16 + 0) | 10 | 0.000210 | 100 | 0.210329 | 0.105164 / 500 | 1 | 6.744 | 29.25 | 226.456 / 0.022646 [K B F C S] | 0.000996 | deposits 0.3821984656 = raise 0.2103288 + refunds 0.1718696656, diff 0 yocto | PASS 23/23 |
| sale-n20c | **bot only, NOT counted as evidence** (house bids never placed) | 44 (0 + 44) | 44 | 0.000200 (reserve) | 44 | 0.088000 | 0.044000 / 220 | 841 | 7.222 | 46.53 | 369.941 / 0.036994 [F C S], create and bot bids excluded | 0.000999 | deposits 0.128437920154 = raise 0.088 + refunds 0.040437920154, diff 0 yocto | PASS 23/23 |
| sale-n20d | sniper "last" + house | 69 (19 + 50) | 69 | 0.000270 | 100 | 0.270361 | 0.135181 / 500 | 1 | 8.519 | 65.67 | 656.438 / 0.065644 [K B F C S], bot bids excluded | 0.001002 | deposits 0.546223212304 = raise 0.2703614 + refunds 0.275861812304, diff 0 yocto | PASS 23/23 |
| sale-n100 | sniper "split" (80 wallets) + house | 100 (20 + 80) | 94 | 0.000257 | 100 | 0.257440 | 0.128720 / 500 | 1 | 7.285 | 88.60 | 140.472 / 0.014047 [F S] only, see flag | 0.001001 | deposits 0.428044853 = raise 0.2574396 + refunds 0.170605253, diff 0 yocto | PASS 23/23 |

Column definitions:
- **bidders (leaves)**: number of allocation leaves, one per bidder account (several bids from one wallet share a leaf).
- **burn**: unsold supply plus unused LP token reserve.
- **finalize->on_clear**: chain time from the `finalize` tx block to the sale's `cleared_at_ns`. It was 6.7 to 8.5 s in 6 of 7 runs (16 to 100 bids) and 11.0 s in one (n30, 30 bids). No growth with bid count is visible in this range; n=1 per size.
- **finalize gas**: gas burnt by the successful `finalize` transaction alone (from the `finalize` step in the sale json). This is the only gas column that is comparable across rows.
- **runner gas total / cost**: gas burnt by the transactions the `launch-runner` invocation that wrote the sale json sent itself, priced at the nominal 1e-4 NEAR/Tgas (100,000,000 yocto/gas). Letters say what is in it: K = `create_sale`, B = house bids placed by that invocation (including bids placed with `--from <sale> --place-bids` for n30 and n50), F = finalize, C = claims sent by the runner, S = settle. It never includes sniper-bot bids or claims sent by `claimrest.mts`. Rows are therefore **not comparable**:
  - n30, n50: the sale was created by an earlier invocation (no K); their `--place-bids` house bids are included.
  - n20c: the creating invocation died before bids (no K, no B); the 44 bot bids are excluded.
  - **n100: house bids excluded.** The 20 house bids were placed with `--from --place-bids` by an invocation that then died at the rejected finalize, so their gas, the `create_sale` gas and the rejected finalize are not in the row. The 94 runner claims failed ("Exceeded the prepaid gas", 12 Tgas) and are recorded without gas; the successful claims were sent later by `claimrest.mts` and are not counted.
  - Claims dominate where many were sent: n10 claims 350.3 Tgas (59 ok), n20d 410.6 Tgas (69), n20c 271.5 Tgas (44).
  - Real testnet prepay is charged at about 10x the nominal price up front; unused gas is refunded.
- **OutLayer net**: creator balance change across finalize minus the finalize gas, about 0.001 NEAR at every size from 16 to 100 bids.
- **refund correctness**: from the saved `verify` summary (`sum_deposits`, `raise`, `sum_refunds`), in NEAR. In every row `sum(deposits) - raise - sum(refunds) = 0` exactly in yocto, and the checks `per-bidder: refund == deposit - ceil(P* * tokens)`, `sum(per-bidder cost) == raise`, `CONSERVATION` and `CONSERVATION incl. fees` all PASS.
- **verify**: all 7 saved outputs end `RESULT: PASS (23 pass, 0 fail, 0 warn, 0 skip)`, including `sale account has 0 access keys`, `P* recomputed == on-chain p_star`, `alloc_root recomputed == on-chain`, `every leaf Merkle proof verifies` and `on-chain recompute flag (verified_onchain)`. With the sale wasm hash now recorded in `deployments.json`, a fresh `pnpm verify` adds one check (24).

Per-row notes:
- sale-n50: 11 of 50 house bids failed with RPC 429 rate limits.
- sale-n20b: 4 of 20 house bids failed (bidder accounts could not prepay gas).
- sale-n20c: house bids were never placed (a shell bug built a bad bidder list). Only bots bid, so it cleared at the reserve with 44% fill. It is a valid sale and verifies, but it says nothing about bots versus honest bidders.
- sale-n20d: 19 of 20 house bids landed.
- sale-n100: 20 house + 80 split bids. The house-bid tx hashes were lost (runner died); the bids themselves are on chain and `verify` reads them.

## Known issue found here: finalize deposit (being fixed, not fixed)

At 100 bids the first `finalize` with a flat 0.1 NEAR deposit was rejected by OutLayer: `Insufficient payment: required 174530500000000000000000 yoctoNEAR (7000500000000000000000 for compute, 167530000000000000000000 held for 49521 bytes of input_data beyond the free 32768), got 100000000000000000000000` (tx [3h4JaX8N...](https://testnet.nearblocks.io/txns/3h4JaX8NU7vCAffTB7wAkWMsRjFWkmDaCKRrAN7vWZjN)). The sale stayed retryable; finalize was sent again inside the 420 s refund window with 0.5 NEAR and cleared (tx [Bxm8JevV...](https://testnet.nearblocks.io/txns/Bxm8JevV474zfbuLTRCo2Eb4vLXQgYrxtPEWxhTaidCD)). The net OutLayer charge was still about 0.001 NEAR; the rest is refunded. The evidence runner attached 0.5 NEAR when `bid_count > 40` as a workaround. The real fix (size the finalize deposit from the input size, in the sale contract, scripts and UI) is being worked on and is **not** part of the runs above.

## Sniper runs

Bot setup: 50 wallets, one bid each, 10 tokens at a random price in [reserve, 2x reserve]. Split: 80 wallets, one price (0.0003 NEAR/token), 6.25 tokens each, 500 tokens total. **Each scenario ran once (n = 1 sale per scenario, n = 50 bot bids, 80 for split).** Bots were sent from one machine through public testnet RPC. They did **not** land in a single block: landed bids are spread over 17 to 47 distinct block timestamps, and sending them took about 22 to 52 s.

| scenario | sale | landed | when landed (block time) | bot winning bids | bot tokens | P* (NEAR/token) | every bot winner paid P* | bot avg price | honest avg price | Spearman arrival time vs fill | Spearman bid price vs fill (contrast) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| first | sale-n10 | 50/50 | 309 to 298 s before the deadline, 17 distinct block timestamps over 11.3 s | 35 | 346 | 0.000260752454 | yes | 0.000260752454 | 0.000260752454 | +0.039 | +0.812 |
| last | sale-n20d | 50/50 | 17.6 to 2.4 s before the deadline, 22 distinct block timestamps over 15.2 s | 32 | 320 | 0.0002703614 | yes | 0.0002703614 | 0.0002703614 | +0.121 | +0.832 |
| split | sale-n100 | 80/80 | 138 to 94 s before the deadline, 47 distinct block timestamps over 44.2 s | 80 | 500 | 0.0002574396 | yes | 0.0002574396 | 0.0002574396 | undefined (every wallet fully filled) | undefined |
| last (not evidence) | sale-n20c | 44/50 | 13.4 to 1.3 s before the deadline | 44 | 440 | 0.0002 (reserve) | yes | 0.0002 | n/a (no honest bids) | n/a | n/a |
| first (**failed run**) | sale-n50 | 0/50 | none: 40 RPC 429 rate-limit errors, 10 "does not have enough balance" | 0 | 0 | 0.000384 | vacuous | n/a | 0.000384 | n/a | n/a |
| last (**failed run**) | sale-n20b | 0/50 | none: 31 "bidding is closed" (fired too late), 18 "does not have enough balance", 1 missing key | 0 | 0 | 0.000210 | vacuous | n/a | n/a | n/a | n/a |

Reading:
- In every valid run each filled bot wallet paid exactly P* per token (cost = ceil(P* x tokens), checked per leaf by `verify`), and the bot average price equals the honest average price. This holds by construction of uniform-price clearing; the runs confirm the deployed contract does it.
- Fill depended on bid price (Spearman +0.81 and +0.83), not on arrival time (+0.04 for "first", +0.12 for "last"; n = 50 each, one sale each).
- Split: all 80 wallets bid 0.0003, all were filled in full, and all paid P* = 0.000257 (about 14% below their bid). Splitting across wallets gave no price advantage.
- Limits: one sale per scenario; bots did not land in one block; all wallets are ours; the two failed runs above were caused by rate limits, underfunded wallets and a late start, not by the contract.

## Attack suite on sale-n10 (attacker `dsl-bidder3.testnet`)

Files: `attacks-sale-n10.sealedlaunch.deathstalker-sl.testnet.{bidding-window,cleared}.{md,json}`.

During the bidding window: forged `on_clear` PASS ("Method on_clear is private"); finalize while bidding open PASS ("bidding still open"); refund on a non-refund sale PASS. The claim, double-claim and bid-after-deadline rows were SKIPPED (not applicable before clearing).

After clearing (run with `--allow-claim` while the runner held claims), 9 attack rows, 0 failures, 0 inconclusive:

| attack | result | tx |
|---|---|---|
| forged `on_clear` | PASS, "Method on_clear is private" | [CHDdVLtT](https://testnet.nearblocks.io/txns/CHDdVLtToNXCqYFzb5Rgk72ap23FKtJR2xcKE6Sx1zU4) |
| claim with tokens+1 and the real proof | PASS, "invalid merkle proof" | [BpxKrsZ4](https://testnet.nearblocks.io/txns/BpxKrsZ4EHGhhBMCVVaymQzWmZj3oRSWZNGwdPHbgoZk) |
| claim with refund+1 yocto and the real proof | PASS, "invalid merkle proof" | [5hQB9U7Y](https://testnet.nearblocks.io/txns/5hQB9U7YSbTg7fPaAJEJTnih7DeZR7QCppUpwD1k3Zpf) |
| claim with an empty proof | PASS, "invalid merkle proof" | [46s8fQcp](https://testnet.nearblocks.io/txns/46s8fQcpSkjdznx8e6YisRBx6pDn2Cz3UfNbQESFaiGN) |
| steal: leaf 0's claim under another account name | PASS, "invalid merkle proof" | [FkT7Ew1j](https://testnet.nearblocks.io/txns/FkT7Ew1jSyKeWwLvR2ZCxAhELvkk14HRG4MhRKCmRjJ3) |
| double claim (after a legitimate setup claim [6aT2ev6R](https://testnet.nearblocks.io/txns/6aT2ev6R8gyW59Zv2SfsmCPVQhfuWNQjxpeGfVWPfGd7)) | PASS, "already claimed" | [G8txPx6T](https://testnet.nearblocks.io/txns/G8txPx6TQZfVBPUDLsv22ZLzDv8mV7u8M9Vqt1sXXQ7B) |
| bid after deadline | PASS, "bidding is closed" | [D67FQqTc](https://testnet.nearblocks.io/txns/D67FQqTcA3UcdRs3acRBSUkjhMbhRRb4CYGuJiEq44UC) |
| finalize on a Cleared sale | PASS, "not finalizable in this state" | [Cf8Bppg3](https://testnet.nearblocks.io/txns/Cf8Bppg3Pk3GUMBBnSgkWij8Y28WhJuVBRhXAw9Fypos) |
| refund on a non-refund sale | PASS, "not in refund mode" | [B8Q1Uuo2](https://testnet.nearblocks.io/txns/B8Q1Uuo2jJ225rTqogvuBhaVuRkrR4vkwkL1LQx4Qnjo) |

Unlike the earlier sale-beta run (3 rows INCONCLUSIVE because every bidder had already claimed), here the three tampered-claim rows reached the Merkle check.

## Not run

- A literal one-block burst of bot bids (public RPC rate limits; see above).
- A 200-bid sale (largest live sale is 100 bids; 200 was measured only in the OutLayer spike and sandbox).
- Challenge flow, `refund_all` with a worker that never answers, and malicious-TEE variants live (sandbox only).
- Sniper "first", "last" and "split" on the same sale; each scenario ran once on its own sale.
- n100 house-bid tx records were lost after the `create_sale` call returned "fetch failed" (the tx had succeeded) and the resumed runner later died at the rejected finalize.
