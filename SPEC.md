# SealedLaunch SPEC v1 (frozen shared formats)

Normative for contract, TEE worker, frontend, and verify script. Reference implementation: `clearing/` (Rust, `no_std`+`alloc`, builds for native and `wasm32-unknown-unknown`). Test vectors: `clearing/vectors.json`. Independent Python re-implementation: `clearing/reference.py` (checks vectors.json; run `python3 -I reference.py` in `clearing/`). If prose and vectors disagree, vectors win; file a bug.

## 1. Conventions

- All integers are unsigned. On the wire (JSON/NEAR args) every u128 is a **decimal string**. Hashes, salts, ciphertexts, proofs are **lowercase hex** (no `0x`).
- In hashed byte strings: `u128` = 16 bytes big-endian; `u32` = 4 bytes big-endian; `str(s)` = `u32 len(utf8 s) ‖ utf8 s`; `salt` = 32 raw bytes. `‖` is concatenation. Hash = SHA-256 everywhere.
- Account ids (bidder, sale) are the exact NEAR account id strings, compared/sorted as raw UTF-8 bytes.

### Units (exact)

| Quantity | Unit |
|---|---|
| `size`, `supply`, `tokens`, `burned` | **sale-token base units**. 1 whole token = `10^D` base units. `D = token_decimals` (create-time param, 0..=24; default 18; library accepts <=38) |
| `price`, `reserve`, `p_star` | **payment-token base units per ONE WHOLE sale token**. Payment token = native NEAR (base unit = yocto, 1 NEAR = 10^24) or a NEP-141 (its own smallest unit). One payment token per sale, fixed at create |
| `deposit`, `refund`, `raise`, `cost` | payment-token base units |

`cost(price, tokens) = ceil(price * tokens / 10^D)` computed with exact 256-bit intermediate (never overflows; if the result exceeds u128 the bid is treated as underfunded). **Rounding is always up on what a bidder pays**, so the seller is never short and refunds are exact integers.

Limits (library-enforced): `1 <= supply <= 2^100`, `reserve >= 1`, `size <= 2^100`, `<= 65536` entries per clearing.

## 2. Bid, commit, ciphertext

```
Bid { price: u128, size: u128, salt: [u8;32] }
bid_bytes (64 B) = u128BE(price) ‖ u128BE(size) ‖ salt          // ECIES plaintext
commit = sha256( u128BE(price) ‖ u128BE(size) ‖ salt ‖ str(bidder) ‖ str(sale_id) )
```
- `bidder` = the NEAR account that calls `bid`; `sale_id` = the sale account id. Length prefixes (`str`) are a deliberate addition to `price‖size‖salt‖bidder‖sale` to remove concatenation ambiguity.
- `ciphertext` = ECIES over secp256k1 (`eciesjs` defaults) of `bid_bytes` to `pk_sale`. Anything that does not decrypt to exactly 64 bytes is "undecryptable".
- `salt` MUST be 32 CSPRNG bytes. Bidder stores it locally (needed for fallback reveal and for challenge).
- Required deposit for a bid: `deposit >= cost(price, size)`. `deposit` is the amount escrowed **net of the non-refundable bid fee** (the fee is taken at `bid` time and never enters clearing).

## 3. Clearing

### Input (`clear(params, entries)`)
```
Params { sale_id, supply, reserve, token_decimals, min_size }
Entry  { bidder, commit[32], deposit, plaintext: Option<Bid> }    // one per on-chain bid slot, in slot-index order
```
`plaintext = None` for: undecryptable, never revealed (fallback), cancelled slot (deposit 0, commit zeros).

### Validation (first failing rule wins; drop = bid ignored, deposit fully refunded)
| # | Rule | DropReason (code) |
|---|---|---|
| 1 | plaintext is None | NoPlaintext (1) |
| 2 | `commit_hash(bid,bidder,sale_id) != commit` | CommitMismatch (2) |
| 3 | `price == 0`, `size == 0`, `size < min_size`, or `size > 2^100` | BadBid (3) |
| 4 | `price < reserve` | BelowReserve (4) |
| 5 | `cost(price,size) > deposit` | Underfunded (5) |

### Algorithm
1. Collect valid bids. Group by price. Order does not matter (result is permutation-invariant except `input_hash`).
2. Walk price levels from highest to lowest keeping `cum` = total size at strictly higher prices. At level price `p` with level size `m`: if `cum + m >= supply` then **P\* = p**, stop. (So P\* = lowest price at which cumulative size >= supply.)
3. **Oversubscribed / exactly subscribed (P\* found):** bids with price > P\* fill `size`; price < P\* fill 0; the marginal level (price == P\*) shares `R = supply - cum` (`0 < R <= m`):
   - `fill_i = floor(size_i * R / m)` (exact 256-bit).
   - `leftover = R - Σ fill_i`. Give +1 base unit to `leftover` bids, chosen by **largest remainder** `(size_i*R mod m)` descending; ties by `commit` ascending (bytewise), then slot index ascending. Only bids with remainder > 0 are eligible (there are always more than `leftover` of them). Each fill stays <= size_i; Σ fill = R exactly. No time priority.
   - `sold = supply`, `burned = 0`.
4. **Undersubscribed (never reaches supply, includes zero valid bids):** `P* = reserve`, every valid bid fills fully, `sold = Σ size`, `burned = supply - sold` (burned, not sold later). Note: demand exactly equal to supply is case 3 (P\* = lowest bid price, may exceed reserve).
5. **Aggregate per bidder** over ALL slots of that bidder (dropped slots contribute deposit only):
   `tokens_b = Σ fills`, `deposit_b = Σ deposits`, `cost_b = cost(P*, tokens_b)`, **`refund_b = deposit_b - cost_b`** (>= 0 guaranteed by rule 5).
6. `raise = Σ cost_b`. **Conservation (checked, error otherwise): `Σ all deposits == raise + Σ refund_b`, exact to the base unit.**
7. Leaves = bidders sorted by UTF-8 bytes ascending, unique; **omit bidders with tokens == 0 and refund == 0.**

A single bidder gets min(size, supply) at their own price (uniform-price property; documented, not a bug).

### ClearingResult
```
p_star, supply, sold, burned, raise, total_deposits : u128
input_hash[32], alloc_root[32]
leaves: [Leaf]          // sorted, see above
outcomes: [Dropped(reason) | Filled(tokens)]   // per slot, same order as input (for the revealed-curve UI)
```
`input_hash = sha256( "SL1/input" ‖ str(sale_id) ‖ u32(n) ‖ n×( str(bidder) ‖ commit ‖ u128BE(deposit) ) )`, entries in slot-index order. Ciphertexts are not hashed (plaintexts are checked against commits).

## 4. Allocation leaf and Merkle tree
```
Leaf { bidder: str, tokens: u128, refund: u128 }
leaf_hash = sha256( 0x00 ‖ str(bidder) ‖ u128BE(tokens) ‖ u128BE(refund) )
node_hash = sha256( 0x01 ‖ left[32] ‖ right[32] )
```
- Level 0 = leaf hashes in leaf order. Each level pairs adjacent nodes; **an unpaired last node is promoted unchanged** (no duplication). Repeat until one node = `alloc_root`. 0 leaves: root = 32 zero bytes. 1 leaf: root = leaf_hash.
- **Proof** = list of sibling hashes, bottom-up. A level where the node is the unpaired last node contributes **no** sibling. Verification needs `(leaf_hash, index, leaf_count, proof)`:
```
h=leaf_hash; idx; n=leaf_count; require idx<n
while n>1: if !(n odd && idx==n-1): s=next(proof) (fail if none); h = idx even ? node(h,s) : node(s,h)
           idx/=2; n=ceil(n/2)
accept iff proof fully consumed && h==root
```
- Contract stores `alloc_root`, `leaf_count`, and a `claimed` set keyed by bidder. Leaf order is derivable by anyone from the published plaintexts, so `verify` can rebuild the tree.

## 5. TEE worker I/O (OutLayer WASM)
Input: `{ params, entries:[{bidder, commit, deposit, ciphertext}] }` (hex). Worker decrypts each (failure -> `plaintext=None`), calls `clear`. Output (JSON):
```
{ sale_id, input_hash, code_hash, p_star, sold, burned, raise, alloc_root, leaf_count,
  plaintexts: [ {price,size,salt} | null ]   // per slot, same order
}
```
**SPEC v1.1 amendments (from OutLayer spike, `spike-outlayer/RESULTS.md`):**
- Return path: `finalize` calls `outlayer.request_execution(source: {Project:{project_id,version_key}}, resource_limits{max_instructions >= 2e9 per 100 bids + headroom, max_execution_seconds 60}, input_data, secrets_ref, response_format:"Json", payer_account_id)`; `on_clear` is a normal `#[private]` callback reading `promise_result` (NOT yield_resume payload). Output may be ~35 KB at 200 bids. `null` result = run failed -> `finalize` may be retried; after `bid_end + T_finalize` -> Refund mode. Gas buffer for the outgoing call must be sized from payload length (70 Tgas buffer worked at 97 KB).
- Decryption-oracle guard (MANDATORY in worker): `derive_pubkey` and `clear` actions refuse unless `NEAR_PREDECESSOR_ID == sale_id` (or factory for derive) AND, for `clear`, `NEAR_BLOCK_TIMESTAMP >= bid_end`. Secret created with `--build <wasm sha256>`. Sale init records project id + wasm hash.
- Ciphertext transport in `input_data` may be base64 (1/3 smaller than hex); wire format for contract args stays hex.
- Bid slots carry optional `refund_to: String` (chain-qualified address, default = bidder's NEAR account) so a later Intents/cross-chain refund can plug in without a contract change; clearing math is unaffected.

Contract `on_clear` checks: predecessor, project, `code_hash`, `sale_id`, `input_hash` == hash of stored slots, single use. If slots <= RECOMPUTE_CAP it rebuilds `entries` from `plaintexts` and runs `clear` itself and requires every output field to equal the TEE's (then the TEE is trusted only for confidentiality/liveness). Above the cap: accept after the challenge window (see §6 `challenge`).

## 6. Contract interfaces (NEAR, Rust SDK; `U128` = decimal string, `Hex` = lowercase hex string)

### Factory `sealedlaunch.testnet`
```rust
#[payable] fn create_sale(&mut self, p: CreateParams) -> Promise
// CreateParams { name: String /*account label*/, symbol: String, token_name: String, icon: Option<String>,
//   token_decimals: u8 /*<=24, default 18*/, auction_supply: U128, lp_token_reserve: U128, creator_supply: U128,
//   reserve_price: U128, min_size: U128, bid_fee: U128, payment_token: Option<AccountId> /*None = NEAR*/,
//   bid_end_ms: U64 /*unix ms*/, challenge_secs: u32, lp_bps: u16 /*<=10000*/, vesting_secs: u64,
//   outlayer_project: String, code_hash: Hex, max_bids: u32 /*<=65536*/ }
// Effects: create sale-<name>.<factory>, deploy sale code, init(p), mint supply to sale, request pk_sale, then DeleteKey on all keys.
fn get_sale_account(&self, name: String) -> AccountId;           // view
fn list_sales(&self, from: u32, limit: u32) -> Vec<AccountId>;   // view
```

### Sale (also the NEP-141 token account; token = same account, keyless)
```rust
// lifecycle: Bidding -> Clearing -> Challenge -> Cleared -> Settled | Refund(VoidedOrTimedOut)
#[payable] fn bid(&mut self, ciphertext: Hex, commit: Hex) -> u32;            // NEAR payment: attached = fee + deposit. returns slot idx
fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
//   NEP-141 payment path. msg = JSON {"action":"bid","ciphertext":Hex,"commit":Hex,"bidder":Option<AccountId> /*defaults to sender_id; lets a relayer/Intents deposit bid on behalf of a NEAR account*/,"refund_to":Option<String>} | {"action":"top_up","idx":u32}; amount includes fee for bid
fn cancel_bid(&mut self, idx: u32);                  // before bid_end; refunds deposit (fee kept); slot becomes deposit 0, commit zeros, empty ciphertext
#[payable] fn top_up(&mut self, idx: u32);           // before bid_end; adds attached to slot deposit; commit/ciphertext unchanged
fn finalize(&mut self);                              // anyone, after bid_end; calls outlayer.request_execution(...) w/ yield; status->Clearing
fn on_clear(&mut self, result: ClearOutput);         // resume callback (see §5); status->Challenge (or Cleared if recomputed on-chain)
fn challenge(&mut self, idx: u32, price: U128, size: U128, salt: Hex);   // window only; if sha256 matches stored commit AND deposit>=cost AND price>=reserve AND bid was dropped/under-filled by TEE: sale VOIDED -> Refund mode
fn claim(&mut self, bidder: AccountId, index: u32, tokens: U128, refund: U128, proof: Vec<Hex>) -> Promise; // after Cleared; sends tokens + refund to bidder; once per bidder
fn is_refund_mode(&self) -> bool;                    // view
fn refund(&mut self, idx: u32) -> Promise;           // only in Refund mode (timeout/void): returns slot deposit in full, once
fn settle(&mut self) -> Promise;                     // anyone, after Cleared: LP at P*, lock LP, burn unsold+unused, start creator vesting
fn claim_vested(&mut self) -> Promise;               // creator vesting
// views
fn get_sale(&self) -> SaleInfo;  fn get_bid_count(&self) -> u32;  fn get_deposits_total(&self) -> U128;
fn get_bid(&self, idx: u32) -> BidSlot;   // {bidder, commit, ciphertext, deposit, ts: U64 /*block timestamp ms at bid time*/}
fn get_clearing(&self) -> Option<ClearingSummary>;  // {p_star,sold,burned,raise,alloc_root,leaf_count,input_hash,status}
fn get_revealed_bids(&self, from: u32, limit: u32) -> Vec<Option<RevealedBid>>; // {price,size,salt,ts}; ts = slot's bid-time block timestamp ms; available from Challenge on
fn get_pubkey(&self) -> Hex;                         // pk_sale, compressed secp256k1 (33 B)
```
Timeouts: yield timeout or `bid_end + T_finalize` without `on_clear` -> status Refund; every slot refundable in full via `refund(idx)` (fee not returned).  Timing rules are contract-only (not covered by vectors).

### Settlement math (contract, integer, floors in seller's disfavour only where noted)
- `lp_funds = floor(raise * lp_bps / 10000)`; `lp_tokens = min(lp_token_reserve, floor(lp_funds * 10^D / p_star))`; then `lp_funds = min(lp_funds, floor(lp_tokens * p_star / 10^D))`. Both sides are sized together so the pool opens at `p_star` (to integer rounding): if the reserve is too small, funds are reduced rather than mispricing, and the remainder of `raise` goes to the creator/treasury. The unused `lp_token_reserve` is burned.
- Creation rule (enforced by factory `create_sale` and sale `new` when `lp_bps > 0`): `lp_token_reserve >= ceil(auction_supply * lp_bps / 10000)`. At any clearing price, tokens needed = `sold * lp_bps / 10000 <= auction_supply * lp_bps / 10000`, so this reserve is always sufficient and the funds reduction never triggers. LP position tokens go to the sale account (no keys = locked).
- `burned` (from clearing) is burned at settle. Creator supply vests linearly over `vesting_secs` from `Cleared` time.

### Fallback mode (commit-reveal, no TEE) — same `claim`/Merkle/`clear` code
```rust
#[payable] fn bid_commit(&mut self, commit: Hex) -> u32;   // attached = fee + reveal_bond + deposit; slot.deposit = attached - fee - reveal_bond; deposit >= cost(price,size) is checked at reveal (else Underfunded drop)
fn reveal(&mut self, idx: u32, price: U128, size: U128, salt: Hex);  // reveal window only; checks sha256==commit; bond returned
fn clear(&mut self);                  // after reveal_end: builds entries (unrevealed -> plaintext None), runs the same clear(), stores root; status -> Cleared directly (no challenge window)
fn slash_unrevealed(&mut self, idx: u32);  // after reveal_end: bond forfeited to treasury; deposit refunded via claim()
```
Entry mapping for fallback: unrevealed slot -> `plaintext=None` (NoPlaintext). Contract runs the identical algorithm on-chain, so no TEE and no Merkle trust: the contract may also store per-bidder results directly instead of a root; the root form is kept for uniform `claim`.

## 7. Test vectors
`clearing/vectors.json`: `commit_vectors` (plaintext bytes + commit), `merkle_vectors` (n = 0,1,2,3,5,6,7: leaf hashes, root, proofs), `clearing_vectors` (params, entries, expected result) for: oversubscribed, undersubscribed_burn, no_bids, exact_demand, margin_tie_prorata, margin_tie_equal_bids, dropped_bids (all 5 reasons), single_bidder, same_bidder_two_bids, yocto_rounding_24dec, random_12_bidders_24dec. Every case satisfies `raise + Σrefund == total_deposits`. All implementations (JS verify script, contract, worker) MUST reproduce these byte-for-byte. Regenerate only intentionally: `GEN_VECTORS=1 cargo test --test vectors`, then `python3 -I reference.py`.
