# Evidence run notes (testnet only)

## Script fixes (scripts/)
- `src/lib/chain.ts`: RPC pool (fastnear x2, rpc.testnet.near.org, drpc), global pacing (90 ms/call), retry on 429. Kept the previous agent's edit, added the two extra endpoints.
- `src/lib/bids.ts`: bid prepaid gas 30 -> 6 Tgas (env BID_GAS_TGAS). Bids burn ~2.8 Tgas; testnet charges ~10x the nominal price for prepaid gas up-front (refunded), so 30 Tgas made small bot wallets "not enough balance".
- `src/launch-runner.ts`: kept previous `--from X --place-bids`; added `--bid-delay <s>` (lets a sniper go first), parallel claims (each leaf claimed by its own bidder if we hold its key, else creator; fallback to creator on insufficient balance; `--claim-gas` default 30 Tgas), finalize deposit 0.5 NEAR when bid_count > 40 (100-bid finalize needs 0.1745 NEAR to OutLayer; 0.1 was rejected, see below).
- `src/sniper-bot.ts`: added Spearman bid-price-vs-fill contrast; preflight gas buffer 0.01 -> 0.007 NEAR.
- `evidence/acct.mts topup` (previous agent) kept. New helpers: `evidence/claimrest.mts` (permissionless claims of leftover leaves, many callers in parallel), `evidence/q.mts` (view call).

## Problems found / honest failures
- sniper-first-n50: all 50 bids failed, nothing reached the chain (per `sniper-first-n50.json`: 40 RPC -429 rate-limit errors, 10 "does not have enough balance"); collect run only for the record (vacuous). Redone on sale-n10.
- sale-n20 (previous attempt, creator dsl-bidder3): settled with 0 bids; abandoned. Name taken, so the real runs are n20b/c/d.
- n20b: sniper "last" fired 5 s before deadline but 50 txs take 20+ s through the paced RPC -> all 50 failed ("bidding is closed" / underfunded). 4 of 20 house bids underfunded. n20c: my shell bug passed a malformed bidder list so no house bids; sniper 44/50 landed. n20d is the clean "last" run (lead 30 s, landed 2.4-17.6 s before deadline).
- n100: runner's create_sale call returned "fetch failed" after the tx had succeeded (sale existed); resumed with `--from --place-bids`. The first finalize was REJECTED by OutLayer: "Insufficient payment: required 0.1745 NEAR (0.0070 compute + 0.1675 held for 49,521 B of input_data beyond the free 32,768), got 0.1". Retried within the 420 s window with 0.5 NEAR: OK. This is a real scaling finding: finalize deposit must grow with bid count (~1.4 KB of input per bid; free up to ~23 bids' worth... 32 KB), and the sale contract / UI should size the attached deposit from bid_count, not use a flat 0.1 NEAR. The house-bid records for n100 were lost (first runner died), only on-chain data and the split file remain. Recovered from `scripts/out/logs/` and confirmed by RPC tx lookup: create_sale `DQJmCGyxVEMjVmFZqfXkbZHYbTny95nhCFh2KVtWiZZh`, rejected finalize `3h4JaX8NU7vCAffTB7wAkWMsRjFWkmDaCKRrAN7vWZjN` (top-level finalize returned `false`, the `outlayer.testnet` receipt failed with the message above); the log also shows 20/20 house bids accepted, without tx hashes. Status: the deposit-sizing fix is being worked on separately; the runs in TABLE.md predate it.
- n100 claims: my 12 Tgas claim gas was too low ("Exceeded the prepaid gas", 94 failures); all 94 leaves were then claimed with 30 Tgas by `claimrest.mts` (8 callers). Default restored to 30. These failed claim txs are in `sale-n100...json` steps.
- bl-40 key is missing (account existed before key save); excluded.
- n20b sniper failure breakdown (per `sniper-last-n20b.json`): 31 "bidding is closed", 18 "does not have enough balance", 1 missing key (bl-40). Not rate limits.
- Rate limits: public testnet RPC (-429) is the dominant failure mode for parallel bots. "Same block" is not achievable from one machine; landed bot bids span 17-47 distinct block timestamps (11-44 s of block time), so "first/last" means a window, not a block.

## Funding / NEAR
Faucet accounts created: deathstalker-sl-5 (n10), -6 (n20b), -8 (n20c), -9 (n20d), -7 (n100), 10 NEAR each = 50 NEAR free. Sale creation deposit 5.004 NEAR each; sale accounts are keyless, so ~24.6 NEAR (5 sales) is locked there (most is wasm storage; the rest bid fees + dust). Remaining on those 5 creators ~25.2 NEAR. House/bot wallets (hb*/bf*/bl*) fell from ~5.8 to 4.3 NEAR (fees, gas). No funds from deathstalker-sl.testnet were spent (2.70 -> 2.70); deathstalker-sl-4 untouched, dsl-bidder3 used only as attacker/claim caller.

## Not run
- Literal "50 bids in one block" (RPC rate limits). 200-bid sale. Challenge / refund_all / malicious-TEE variants (need contract-level setup). Creator 0-keys screenshot (verify.ts checks keys via RPC, PASS in every verify file). Sniper "first" and "last" on the same sale as split; each scenario ran once.
