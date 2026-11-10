# SealedLaunch

A sealed-bid batch auction for launching a NEP-141 memecoin on NEAR. Bids are encrypted to a key that only an OutLayer TEE (Intel TDX) can use, everyone who wins pays one clearing price P*, the sale lives in an account with zero access keys, and anyone can recompute the result from public data.

Built at NEAR HACKATHON (tracks: Memecoins With Mechanics, Privacy & Private AI; DeFi optional). **Testnet only.** Nothing here has been deployed to or run on mainnet.

## The problem

Memecoin launches are won by bots, not buyers. Whoever is first in the block (bundles, tips, gas wars) gets the cheap tokens, and later buyers become exit liquidity. A public launch also lets the creator change rules or pull the liquidity.

## What SealedLaunch does

| Property | How |
|---|---|
| No speed advantage | Bids are `ECIES(secp256k1)` ciphertexts. Bid time and order do not affect the outcome. |
| One price for everyone | Uniform-price batch clearing: P* is the lowest price at which cumulative demand reaches the supply. Bidders above P* get tokens at P* and the rest of their deposit back. Bids exactly at P* are filled pro rata (no time priority). |
| Nobody sees bids early | Only the TEE worker can decrypt, and only for a `clear` request that comes from the sale contract itself after the bid deadline (the decryption-oracle guard, below). |
| The TEE is not trusted for correctness (up to 200 bids) | The worker publishes every plaintext. The sale contract checks each against its on-chain commit and re-runs the clearing itself; any mismatch rejects the result. |
| Creator cannot change the rules | The factory creates the sale account in one atomic batch with no `AddKey`. The sale account never has an access key. |
| Pool opens at the discovered price | `settle` adds liquidity on Ref Finance sized so the pool price equals P*. LP shares stay in the keyless account. Unsold supply is burned. |
| Anyone can audit | `pnpm verify <sale>` recomputes P*, the allocation Merkle root, every refund and exact conservation of funds from chain data. |

Flow: `create` (factory deploys a keyless sale, OutLayer derives the sale's public key) -> `bid` (deposit + ciphertext + commit) -> `finalize` after the deadline (anyone; the sale calls OutLayer) -> `on_clear` (contract recomputes) -> `claim` with a Merkle proof / `refund` -> `settle` (Ref LP at P*, burn, creator payout).
If the worker fails or never answers, `bid_end + finalize_timeout` opens Refund mode and every deposit comes back.

## Try it: do X, see Y

Prerequisites: Node 20+ and pnpm; Rust (stable) and `python3` for step 2. Run `pnpm install` in each directory you use (`clearing-js/`, `scripts/`, `web/`).

### 1. Run the offline mock UI (no wallet, no network)

```sh
cd web
pnpm install
NEXT_PUBLIC_MOCK=1 pnpm dev        # same as: pnpm dev:mock
```
Open http://localhost:3000. **You should see** a list of three seeded sales (`Moon Rat` open for bidding, `Pepe Fork` already cleared, `Needs Finalize`). Open `Moon Rat`, place a bid as one of the mock accounts, then open the cleared `Pepe Fork` to see the revealed demand curve, P*, the verify panel and the "0 access keys" check.
The mock is an in-memory fake chain, but it runs the real `clearing-js` (real ECIES encryption, real commits, real clearing and Merkle proofs). It is **not** a blockchain and proves nothing about the contracts. I confirmed that the dev server starts and serves `/` (HTTP 200); I did not click through every page in a browser.

### 2. Run the clearing and web tests

```sh
cd clearing    && cargo test                 # Rust reference impl, 16 unit + 1 vector test
cd clearing    && python3 -I reference.py    # independent Python re-implementation checks vectors.json
cd clearing-js && pnpm install && pnpm test  # TypeScript port, 23 tests against the same vectors
cd web         && pnpm test                  # 4 tests: mock chain end to end with real clearing-js
cd scripts     && pnpm install && pnpm test  # self-test: verify passes on honest data and fails on 4 tampered variants
cd outlayer-wasm && cargo test               # TEE worker native tests (guard matrix, ECIES round trips, all vectors), 10 tests
```
**You should see** all green. Observed on 2026-11-11: `clearing` 16 + 1 passed; `clearing-js` 23 passed; `web` 4 passed; `scripts` selftest all `ok`; `outlayer-wasm` 10 passed; the Python reference prints `merkle N True` lines and each clearing case `OK`.
The contract suites (`contracts/sale`: 17 sandbox tests, `contracts/factory`: 5) need `near-workspaces`, which downloads a sandbox binary; they are described in `contracts/sale/NOTES.md` and `INTEGRATION.md` and were **not re-run for this README**.

### 3. Verify the real testnet sales

```sh
cd scripts
pnpm install
pnpm verify gamma      # also: beta, alpha, or a full account id; --all; --json
```
`verify` reads the sale's state over public testnet RPC (no keys), recomputes the clearing with `clearing-js`, and checks it against what the contract stored. Output obtained on 2026-11-11 (`sale-gamma`, exit code 0):

```
SealedLaunch verify: sale-gamma.sealedlaunch.deathstalker-sl.testnet   status=Settled

  PASS  sale account has 0 access keys
  PASS  sale wasm sha256 == hash recorded in deployments.json
  PASS  sale wasm sha256 == factory's current embedded sale wasm
  PASS  sale lives under the factory account
  PASS  sale.params.factory == factory in deployments.json
  PASS  bid_count == number of slots read
  PASS  sum(slot deposits) == get_deposits_total
  PASS  fees_accrued == bid_count * bid_fee (+ any bonds/slashes)
  PASS  P* recomputed == on-chain p_star
  PASS  alloc_root recomputed == on-chain
  PASS  leaf_count recomputed == on-chain
  PASS  input_hash recomputed == on-chain
  PASS  sold recomputed == on-chain
  PASS  burned recomputed == on-chain
  PASS  raise recomputed == on-chain
  PASS  sold + burned == auction_supply
  PASS  P* >= reserve_price
  PASS  on-chain recompute flag (verified_onchain)
  PASS  every filled bid offered >= P* (uniform price)
  PASS  every leaf Merkle proof verifies against alloc_root
  PASS  per-bidder: refund == deposit - ceil(P* * tokens)
  PASS  sum(per-bidder cost) == raise
  PASS  CONSERVATION: sum(deposits) == raise + sum(refunds)
  PASS  CONSERVATION incl. fees: sum(deposits)+n*fee == raise + sum(refunds) + fees_accrued

  per bidder (yocto / base units):
    dsl-bidder1.testnet   tokens=260000000000000000000 cost=2652000000000000000000000 refund=1033000000000000000000000 proof=ok
    dsl-bidder2.testnet   tokens=240000000000000000000 cost=2448000000000000000000000 refund=160000000000000000000000 proof=ok
    dsl-bidder3.testnet   tokens=0 cost=0 refund=1765000000000000000000000 proof=ok

  RESULT: PASS  (24 pass, 0 fail, 0 warn, 0 skip)
```
`pnpm verify beta` also ends `RESULT: PASS (23 pass, 0 fail, 1 warn, 0 skip)`; the warning is expected (beta was created from an older sale wasm than the factory's current one). `pnpm verify alpha` ends `RESULT: PASS (8 pass, 0 fail, 1 warn, 1 skip)`: alpha is the failed-run case in Refund mode, so there is no clearing to recompute.
Read as: 3 bidders, 7 bids (one below reserve and dropped), P* = 0.0102 NEAR/token, 500 tokens sold, raise 5.1 NEAR, and every yocto of deposits is accounted for. The public RPC default is `https://test.rpc.fastnear.com`; override with `NEAR_RPC`.

### 4. Look at it on the explorer

Explorer is https://testnet.nearblocks.io. All ids and transaction hashes are in [`deployments.json`](deployments.json).

| What | Link |
|---|---|
| Factory | [sealedlaunch.deathstalker-sl.testnet](https://testnet.nearblocks.io/address/sealedlaunch.deathstalker-sl.testnet) |
| sale-gamma (round 2, current wasm) | [account](https://testnet.nearblocks.io/address/sale-gamma.sealedlaunch.deathstalker-sl.testnet) |
| sale-beta (round 1 happy path) | [account](https://testnet.nearblocks.io/address/sale-beta.sealedlaunch.deathstalker-sl.testnet) |
| sale-alpha (failed run -> refund) | [account](https://testnet.nearblocks.io/address/sale-alpha.sealedlaunch.deathstalker-sl.testnet) |
| gamma: create_sale | [7MzxF7w1...](https://testnet.nearblocks.io/txns/7MzxF7w1muS1T9CgRQs1yBhvXRQsNcz1XYdroEZzKjnv) |
| gamma: finalize (real OutLayer clear, on-chain recompute) | [GscXdUwd...](https://testnet.nearblocks.io/txns/GscXdUwdNg8RDvhGKWAPBY32wRFFdGGL8uNnTXkspLXE) |
| gamma: settle (Ref LP at P*) | [6PyY1jBk...](https://testnet.nearblocks.io/txns/6PyY1jBkhyWHJMpP9YB3BKXgs4jCRV7uJ9pCaCQbn67P) |
| gamma: finalize too early (rejected) | [Bv8KoiiN...](https://testnet.nearblocks.io/txns/Bv8KoiiNEdpf9Nisy53Rz5RjdNeUD7SFahSU1sC1kknc) |
| beta: create_sale | [Bqn8rZVL...](https://testnet.nearblocks.io/txns/Bqn8rZVLN1Diadb3n28xRUBc2HipFizBvekLEG797dt) |
| beta: finalize (real OutLayer clear) | [2z8yk4rX...](https://testnet.nearblocks.io/txns/2z8yk4rX4ByMT5tqysPeXCZH3RzKhrfcrU1W4GN5W42T) |
| beta: forged claim rejected | [GbqeDftS...](https://testnet.nearblocks.io/txns/GbqeDftSATnCmE23NvRLbCTTgni18d5RHJ7VytChWdCw) |
| beta: claim twice rejected | [FxsRr71Q...](https://testnet.nearblocks.io/txns/FxsRr71Q72tJgYJ68PcHpFV7DJ7k264yitgM7oJK4mvD) |
| beta: settle (Ref LP, see limitation on pool price) | [DWD7gpeq...](https://testnet.nearblocks.io/txns/DWD7gpeqkrXfjih3zShEiYG5JWqdMc6pnxewkmZEGVW) |
| alpha: decryption-oracle attack refused by the worker guard | [ATNfDi1v...](https://testnet.nearblocks.io/txns/ATNfDi1v13a6z3Atb4yUUzLudGztMJmWHFBeiYHSnnpi) |
| alpha: refund_all (5 deposits returned) | [A46Dw6K8...](https://testnet.nearblocks.io/txns/A46Dw6K8ajUHxExG9NTU6zfcfQA4Npa6kBXGz4zqCKiW) |
| Ref pool 2935 (gamma LP) | `ref-finance-101.testnet`, view `get_pool` with `pool_id: 2935`: 250e18 token + 2.55e24 wNEAR = 0.0102 NEAR/token = P* |

To check the "zero keys" claim yourself: `bash contracts/factory/scripts/verify_keyless.sh sale-gamma.sealedlaunch.deathstalker-sl.testnet`, or call RPC `view_access_key_list` on the sale account (returns `[]`; `pnpm verify` also checks it).

## Evidence

- Full table of runs, costs and results: [`scripts/evidence/TABLE.md`](scripts/evidence/TABLE.md) (produced by `scripts/launch-runner.ts` and `scripts/sniper-bot.ts`). **At the time this README was written that file did not exist yet; if it is missing from your checkout, the table was not produced and no sniper-simulation numbers are claimed.**
- Live attack suite against sale-beta: [`scripts/evidence/attacks-sale-beta.sealedlaunch.deathstalker-sl.testnet.md`](scripts/evidence/attacks-sale-beta.sealedlaunch.deathstalker-sl.testnet.md) (raw: `.json`). Result: 6 of 9 rows PASS (forged `on_clear`, claim with a swapped bidder name, double claim, bid after deadline, finalize on a settled sale, refund outside refund mode). 3 rows (inflated tokens, refund+1, empty proof) are marked **INCONCLUSIVE**: by then every bidder had already claimed, so the "already claimed" check fired before the Merkle check. The Merkle check itself was exercised live by the swapped-name row and by `claim_forged_rejected` in `deployments.json` (rejected "invalid merkle proof").
- Sandbox attack coverage (mock OutLayer): `contracts/sale/NOTES.md`.
- OutLayer measurements (cost, latency, 10 to 200 bids): [`spike-outlayer/RESULTS.md`](spike-outlayer/RESULTS.md). Net cost 0.0026 NEAR at 10 bids to 0.0057 NEAR at 200 bids, latency 8 to 11 s, measured on testnet through a probe contract.
- Live run summary and every integration bug found: [`INTEGRATION.md`](INTEGRATION.md).

Sale sizes actually run live: 5 bids (beta), 7 bids (gamma), 5 bids (alpha). Larger counts (up to 200) were measured only in the OutLayer spike and the contract gas benchmark in the sandbox.

## Status: verified live vs sandbox vs not built

| Capability | Status |
|---|---|
| Factory creates a keyless sale in one atomic batch (no `AddKey`) | **Live** (alpha, beta, gamma; 0 keys by RPC after create and after settle) |
| OutLayer `derive_pubkey` per sale, ECIES bids from `eciesjs`, TEE clears, result returns to `on_clear` | **Live** (beta, gamma) |
| On-chain recompute of the clearing in `on_clear` and rejection of mismatches | **Live** happy path (beta, gamma). Rejection paths for tampered results: **sandbox** only |
| `claim` with Merkle proofs; forged and double claims rejected | **Live** (beta) |
| `settle` with real Ref Finance LP | **Live** (beta pool 2934, gamma pool 2935). Pool opens at P* exactly only from gamma onward (see Known limitations) |
| Refund mode via `refund_all` after a failed OutLayer run | **Live** (alpha). It was a worker error, not a worker that never answers |
| Decryption-oracle guard refuses a direct `clear` | **Live** (one refusal, alpha) plus native tests |
| `claim_vested`, `withdraw_fees` | **Live** (beta); other callers' access not probed |
| NEP-141 payment path and `ft_on_transfer` (Intents-style bid via `msg`) | **Sandbox only** |
| Challenge flow (`challenge`, `challenge_recompute`), above-200-bid Challenge window | **Sandbox only**. **No challenge UI exists** |
| Commit-reveal fallback (`bid_commit`, `reveal`, `clear`, `slash_unrevealed`) | **Sandbox only**, NEAR-only; no UI |
| `cancel_bid`, `top_up`, `retry_pk`, `retry_payout` | **Sandbox only** |
| Web UI against live testnet with a wallet | Code exists (`web/`, wallet selector); **I did not verify it end to end**. The verified UI path is the offline mock |
| 1Click / Intents bidding from other chains | **Not built as a working path.** Researched in `INTENTS.md` (conditional yes: `customRecipientMsg` -> `ft_transfer_call` -> `ft_on_transfer`). Intents has no testnet, so the single-step path is untested and mainnet-only. A flag-gated panel exists in `web/`; do not treat it as working |
| On-chain verification of the TDX attestation | **NOT done.** See trust model |
| Mainnet deployment | **None** |

## Trust model

- **OutLayer operator and TEE: trusted for confidentiality and liveness.** If the OutLayer worker or keystore is compromised, bids can be read early (and the single master secret exposes every sale, see limitations). If it does not answer, the sale falls back to Refund mode after `bid_end + finalize_timeout` (420 s in the deployed defaults).
- **Not trusted for correctness, up to 200 bids.** `on_clear` rebuilds the entries from the published plaintexts, checks each against its commit, re-runs the clearing and requires every field (P*, sold, burned, raise, `alloc_root`, leaf count, `input_hash`) to match. Gas for the recompute at 200 bids was measured in the sandbox at about 57 Tgas (`contracts/sale/NOTES.md`). Above the cap the result is accepted after a challenge window, and anyone can run `challenge_recompute`. That path is sandbox-tested only.
- **What the contract actually checks about the caller:** the callback is the `.then` of the contract's own call to `outlayer.testnet`, so it only runs with OutLayer's response. It checks nonce, `sale_id`, and that `input_hash` equals the hash of the stored slots. The `code_hash` in the worker output is an echo of an input field (a WASM cannot know its own hash), **not proof**. The contract does not check the project id and **does not verify the TDX attestation quote**: the OutLayer callback payload carries no quote. Per-execution quotes exist off chain (`testnet-api.outlayer.ai/attestations/by-tx/{tx}`); I confirmed in the spike that the attested `output_hash` equals the hash of what the callback received, but did not verify the quote's Intel signature chain.
- **Why "only the attested WASM can decrypt" holds:** the master secret `PROTECTED_SL_MASTER` was created with `--build 607df359...` (sha256 of the worker WASM). In the spike a leaky WASM version was refused by the keystore ("locked to build ..."). This check is made by OutLayer's keystore on the worker's word, so the trust anchor is OutLayer's TDX worker and keystore.
- **Funds:** deposits sit in the sale account; the creator has no key and no privileged method that can touch escrow. `withdraw_fees` runs only after Settled/Refund and leaves escrow and the storage reserve alone.

### The decryption-oracle guard

A build-locked WASM will decrypt whatever ciphertexts it is handed, so anyone allowed to run it could decrypt a single bid early. The worker (`outlayer-wasm/`) therefore refuses, before touching the secret or any ciphertext, unless `NEAR_PREDECESSOR_ID` is exactly the sale contract and `NEAR_BLOCK_TIMESTAMP >= bid_end_ms`; `derive_pubkey` is allowed only from the sale or its factory. `bid_end_ms` is taken from the input, which is sound because only the sale contract can be the predecessor and it builds `input_data` from its own state. Tested natively (wrong, empty and lookalike predecessors, early time, ms-vs-ns confusion) and refused once live from a bidder account: `refused: predecessor 'dsl-bidder1.testnet' is not sale ...` (tx linked above). This guard is only as strong as OutLayer's `NEAR_PREDECESSOR_ID` and timestamp env vars; I did not audit those.

## Known limitations

- **Public deposits leak a demand upper bound.** Every bid is fully funded (`deposit >= price x size`) and deposits are visible, so the total and each deposit bound the demand. No padding or bucketing is implemented.
- **Uniform-price bid shading.** Multi-unit uniform-price auctions reward demand reduction, so this is not a truthful mechanism. The claim is "no speed advantage, same price for everyone", not "bid your true value". A single bidder is filled at its own price up to the supply.
- **One master secret.** All sales derive keys from one `PROTECTED_SL_MASTER` with per-sale HKDF. A compromise exposes every sale's bids.
- **No per-wallet fairness.** Splitting across wallets is free; the design does not stop sybils, it removes the reason to race.
- **Ref pool price on sale-beta is wrong.** Beta's pool 2934 opened at about 0.025 NEAR/token versus P* 0.0101 because the first `settle` sizing capped tokens at the reserve. Fixed in the round-2 wasm; gamma opened at P* exactly. Beta is keyless and cannot be repaired. LP creation is a chain of promises; if it fails midway `lp_status = Failed` with no recovery path (did not happen).
- **Pool creation front-running** on Ref (pool creation and first liquidity are separate calls) is not mitigated.
- **Cost:** creating a sale needs about 5.0 NEAR (wasm storage, mostly locked in the keyless account).
- **Unclaimed transfers** (malformed `ft_on_transfer` messages) have no storage payer; small grief vector, not mitigated.
- **Small live samples:** 5 to 7 bids per live sale. No outside bidders; all live bidders are our own testnet accounts.
- Not live-tested: a worker that never responds at all, the 10-minute stale re-finalize path, anything above 7 bids on a real run.
- Mainnet and Intents: none; legal and real-money considerations are out of scope for this testnet build.

## NEAR AI Cloud is not used

The Privacy track lists NEAR AI Cloud, but it only signs inference and cannot hold a decryption key or run clearing code. SealedLaunch uses OutLayer instead (on the hackathon ecosystem list).

## Architecture and repo map

| Path | What |
|---|---|
| `SPEC.md` | Frozen wire formats, clearing algorithm, Merkle tree, contract interface (SPEC v1.1 includes OutLayer amendments) |
| `clearing/` | Rust `no_std` reference clearing + Merkle (`vectors.json`, `reference.py`) shared by contract and worker |
| `clearing-js/` | TypeScript port used by the web app and scripts (same vectors) |
| `outlayer-wasm/` | TEE worker (`wasm32-wasip1`): decrypt, validate, clear, guard. Live project `deathstalker-sl.testnet/sealedlaunch`, build `607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6` |
| `contracts/sale/` | Sale + NEP-141 token contract, [`NOTES.md`](contracts/sale/NOTES.md) |
| `contracts/factory/` | Factory that embeds the sale wasm and creates keyless sales, [`NOTES.md`](contracts/factory/NOTES.md) |
| `web/` | Next.js UI (create, bid, demand curve, sniper board, claim, verify panel), mock mode `NEXT_PUBLIC_MOCK=1` |
| `scripts/` | `verify`, `sniper-bot`, `launch-runner`, `attack-suite`, evidence output in `scripts/evidence/` |
| `spike-outlayer/` | The OutLayer feasibility spike and measured results |
| `deployments.json` | Every testnet account, hash and transaction id |
| `INTEGRATION.md`, `INTENTS.md`, `RESEARCH.md`, `SEALED_LAUNCH.md` | Live integration log, Intents research, version/Ref research, original design and plan |

Design notes (`SEALED_LAUNCH.md`) describe the full plan including items that are not built; this README and the status table are the source of truth for what runs.

## Disclosure: what was built when

- Everything in this repository was written during the hackathon window (the OutLayer spike began on 10 Nov 2026; all deployments are dated 2026-11-11). The git history has no earlier commits. There is no pre-hackathon codebase or previously existing product on another chain.
- Much of the code was written with AI assistance (Claude Code agents).
- Libraries: `near-sdk` 5.30.1 and `near-contract-standards` 5.30.1 (token), `near-workspaces` 0.24 (sandbox tests), `sha2`, `hkdf`, `ecies` 0.2 with `libsecp256k1`, `serde`, `base64` (Rust); `eciesjs` 0.4.x, `@noble/hashes`, `near-api-js` 5.1.1, `@near-wallet-selector/*`, Next.js 15.5, React 19, `vitest`, `tsx` (TypeScript).
- Pattern followed, not copied: key derivation (`HKDF-SHA256` per account from a protected OutLayer secret) plus ECIES, as in `private-dao-example`.
- Platforms used: OutLayer (`outlayer.testnet`, its CLI and FastFS hosting), Ref Finance testnet (`ref-finance-101.testnet`, `wrap.testnet`), NEAR testnet RPC.
- Prior art we build on conceptually (see `SEALED_LAUNCH.md` section 4): uniform-price batch auctions (Gnosis EasyAuction, Uniswap CCA, Metaplex Genesis). The claim is the combination of sealed bids, keyless sale, on-chain recompute and NEAR, not the uniform price itself.

## Other hackathon projects by the same team

<!-- PLACEHOLDER (Q-015): the submitter fills this in before submission. Each README must name the other project. -->
`<OTHER_PROJECT_NAME and REPO_URL, filled in by the submitter>`

## Tracks

- **Memecoins With Mechanics (`memecoins`)**: the mechanic is the auction itself: sealed bids, one clearing price, LP opened at P*, unsold supply burned, creator share vested, NEP-141 token minted by the keyless sale.
- **Privacy & Private AI (`privacy`)**: confidential computation (sealed bids decrypted only inside an OutLayer TDX enclave) with the output re-verified on chain.
- DeFi (`defi`, optional): Ref Finance LP at the clearing price; Intents is researched but not working.

## License

MIT, see [`LICENSE`](LICENSE).
