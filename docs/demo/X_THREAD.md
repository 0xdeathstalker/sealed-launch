# X demo post + thread

Hackathon requirements for the main post: says **Built at NEAR HACKATHON**, tags **@NEARProtocol**, uses **#NEARHackathon**, has the **video** attached (or the fallback screenshots).
Char counts are for X (URLs and the `<DEMO_URL>` placeholder count as 23). Every number comes from `README.md`, `deployments.json`, `scripts/evidence/TABLE.md` and `scripts/evidence/NOTES.md`. Testnet only, all bidders are our own wallets. Replace `<DEMO_URL>` with the video link, then re-check every post is <= 280.

## Main post (attach the demo video)

```text
80 bot wallets bid in a memecoin launch on NEAR testnet. All 80 were filled and paid the same price as every other winner.

Sealed bids in a TEE, one clearing price, 0 access keys on the sale. Testnet, our wallets.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

(268 chars.) No link in the main post. Fallback media if the video is not ready: screenshot of `demo/index.html` (offline demo, mock chain) and of the `## Sniper runs` table in `scripts/evidence/TABLE.md`. The 80 wallets are the "split" run on sale-n100 (all 80 filled, all paid P* = 0.000257 NEAR/token; TABLE.md).

## Replies

**1/ How it works** (attach: screenshot of `demo/index.html` (offline demo page, mock chain running the real `clearing-js`; say so in the video or alt text))
```text
Bids are ECIES ciphertexts, so arrival order does not matter. Only an OutLayer TEE can decrypt, and only on the sale contract's request after the deadline.

All winners pay one price, P*: the lowest price where demand reaches supply. Higher bids pay P* and get the rest back.
```
(275 chars.)

**2/ The TEE is not trusted for correctness**
```text
The worker publishes every plaintext bid. The sale contract checks each one against its on-chain commit and re-runs the clearing itself in on_clear. Any mismatch rejects the result (up to 200 bids).

Limit: live runs show the happy path. The rejection path is sandbox-tested only.
```
(280 chars.)

**3/ Keyless sale** (attach: screenshot of the first lines of `scripts/evidence/verify-sale-n100.sealedlaunch.deathstalker-sl.testnet.txt` (first check: `PASS  sale account has 0 access keys`))
```text
The factory creates the sale account in one atomic batch with no AddKey, so the creator holds no key and cannot change the rules or touch escrow.

Check it yourself: RPC view_access_key_list on the sale account returns []. pnpm verify checks it on every run.
```
(258 chars.)

**4/ Pool at the clearing price**
```text
settle sizes the Ref liquidity so the pool opens at P*. sale-gamma cleared at 0.0102 NEAR/token; Ref pool 2935 opened at 0.0102.

Our first sale (beta) opened at about 0.025 vs 0.0101: fixed later, but beta is keyless and stays wrong.

https://testnet.nearblocks.io/txns/6PyY1jBkhyWHJMpP9YB3BKXgs4jCRV7uJ9pCaCQbn67P
```
(259 chars.)

**5/ Sniper runs** (attach: screenshot of the `## Sniper runs` table in `scripts/evidence/TABLE.md` (raw data: `scripts/evidence/sniper-first-n10.json`, `sniper-last-n20d.json`, `sniper-split-n100.json`))
```text
Do bots win by speed? 3 testnet scenarios, one sale each: 50 bots early, 50 in the last 17 s, 80 split wallets.

Fill followed bid price (Spearman +0.81, +0.83), not arrival time (+0.04, +0.12). Every winning bot paid P*.

Bots spanned 17 to 47 block timestamps, not one block.
```
(277 chars.)

**6/ Attacking our own sale** (attach: screenshot of `scripts/evidence/attacks-sale-n10.sealedlaunch.deathstalker-sl.testnet.cleared.md`)
```text
We attacked our own sale-n10 after clearing: forged on_clear, claim with tokens+1, refund+1 yocto, empty proof, a claim under another name, double claim, late bid, finalize on a cleared sale, refund outside refund mode.

9 of 9 rejected on chain, each with a tx hash in the repo.
```
(279 chars.)

**7/ Anyone can verify** (attach: screenshot of the `RESULT:` line of `scripts/evidence/verify-sale-n100.sealedlaunch.deathstalker-sl.testnet.txt`)
```text
pnpm verify <sale> reads public testnet RPC, recomputes P*, the allocation Merkle root, every refund and exact conservation of funds, and compares them with what the contract stored.

All 7 larger sales (16 to 100 bids) saved PASS 23/23, down to the yocto.
```
(256 chars.)

**8/ Honest limits**
```text
Limits: testnet only. All bidders are our own wallets, one sale per setup. Deposits are public, so they leak a demand upper bound. The TDX quote is not verified on chain. Intents bidding is not working. A flat 0.1 NEAR finalize deposit failed at 100 bids; fix in progress.
```
(272 chars.)

**9/ Closer**
```text
Nobody wins a launch by being faster, so nobody needs to race: one price, a keyless sale, a pool at the price that was found.

Code, evidence table and limits: github.com/0xdeathstalker/sealed-launch
Demo: <DEMO_URL>

Reply with the attack you would try next.
```
(256 chars.)

Handles: tag only @NEARProtocol (required). Verify any other handle (OutLayer, Ref Finance) before adding it.
Repost targets: @NEARProtocol, OutLayer, Ref Finance, memecoin and auction-design accounts.

## Alternative hooks (swap in for line 1 of the main post)

A. Question hook:
```text
Can a memecoin launch be fair if bots are faster than you? We sealed the bids, charged every winner one price, and ran 80 bot wallets against it on NEAR testnet.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

B. Result hook:
```text
Arrival time vs fill in a sealed-bid launch on NEAR testnet: Spearman +0.04 for bots bidding early, +0.12 for bots bidding last. Bid price vs fill: +0.81 and +0.83. One sale each, our own wallets.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```
