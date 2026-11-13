# INTENTS.md: can a 1Click deposit carry the SealedLaunch bid payload?

Researched 2026-11-10/11. Read-only: OpenAPI spec, `near/intents` source (shallow clone), docs pages, and `dry:true` quotes against `https://1click.chaindefuser.com/v0/quote` with no JWT. No non-dry quote was made, so no deposit address was created and nothing was spent.

Labels: **VERIFIED** (source or real response, cited) and **UNVERIFIED** (inferred or not tested).

## Verdict: CONDITIONAL YES

A 1Click swap from ETH, SOL or BTC can end in `wrap.near.ft_transfer_call(sale, amount, msg)` with an arbitrary `msg` of up to 1024 characters. The sale contract's `ft_on_transfer(sender_id, amount, msg)` then receives the ciphertext and commit in one step. The field is `customRecipientMsg`, and the API labels it "HIGHLY EXPERIMENTAL".

The conditions that matter:

1. `sender_id` is the Intents (Defuse) contract, not the bidder. Bidder identity and the refund address must live inside `msg`.
2. `msg` is not authenticated. Anyone who deposits can claim any identity in it.
3. A rejected or partially-used transfer does not go back to the origin chain automatically.
4. The sale account must exist and be storage-registered on the token. Only existence was probed.
5. The path has not been exercised end to end on mainnet, and Intents has no testnet. Ship it only as a stretch that has run once with a small amount.

## 1. Evidence

| # | Claim | Status | Source |
|---|---|---|---|
| 1 | `QuoteRequest.customRecipientMsg`: "Message to pass to `ft_transfer_call` when withdrawing assets to NEAR. Otherwise `ft_transfer` will be used." Funds are lost with non-NEP-141 tokens, insufficient `storage_deposit`, or a recipient without `ft_on_transfer`. | VERIFIED | OpenAPI at https://1click.chaindefuser.com/docs/v0/openapi.yaml (lines ~1635 and ~1902); docs https://docs.near-intents.org/near-intents/1click-api |
| 2 | The server accepts the field in a dry quote and echoes it back in `quoteRequest.customRecipientMsg` (JSON string, short string, 400-char string, and `""`). | VERIFIED | Dry quotes returned HTTP 201 |
| 3 | The hard limit is 1024 characters. A 4000-char message returned HTTP 400 `customRecipientMsg must be shorter than or equal to 1024 characters`. | VERIFIED | Dry quote |
| 4 | Our payload fits. Base64 or hex of ~300 bytes is 400-600 chars. Use base64url JSON or borsh-base64, not hex-in-JSON, to stay well under 1024. | VERIFIED (limit) | Dry quote |
| 5 | Works for ETH (`nep141:eth.omft.near`), SOL (`nep141:sol.omft.near`) and BTC (`nep141:btc.omft.near`) as origin, with `wrap.near` or mainnet USDC as destination. USDC is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. | VERIFIED (quote only) | `/v0/tokens` plus dry quotes returning 201 with `customRecipientMsg` set |
| 6 | The Verifier's `FtWithdraw` intent has `msg: Option<String>`. `Some(msg)` calls `ft_transfer_call(receiver_id, amount, memo, msg)`; `None` calls `ft_transfer`. | VERIFIED | `near/intents` `contracts/defuse/core/src/intents/tokens.rs` (`FtWithdraw`); `contracts/defuse/src/contract/tokens/nep141/withdraw.rs`; docs https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals |
| 7 | Default gas for `ft_transfer_call` is 50 TGas (minimum 30). The remainder is spread across the promise. Keep `ft_on_transfer` light: store the blob and emit an event, with no cross-contract calls. | VERIFIED | `FtWithdraw.min_gas` doc comment |
| 8 | The 1Click path that calls `ft_transfer_call` is the Verifier `ft_withdraw`, so `sender_id` in `ft_on_transfer` is the caller of `ft_transfer_call`. That is the Verifier contract (expected `intents.near`), not the bidder or the origin-chain address. | VERIFIED in the Verifier code; account id of the live deployment UNVERIFIED (check it) | `withdraw.rs` |
| 9 | Refund semantics after `ft_transfer_call`. If the token returns used < amount (e.g. `ft_on_transfer` returns the unused part), `ft_resolve_withdraw` re-credits the unused part to the sender's Intents balance. That sender is 1Click's internal swap account, not the bidder and not the origin chain. If the result cannot be read at all (out of gas), no refund is made. The docs say only omitting `msg` gives refund protection. | VERIFIED (code and docs) | `ft_resolve_withdraw` in `withdraw.rs`; the withdrawals docs page |
| 10 | Whether 1Click ops later forward the stuck Intents balance to the user. | UNVERIFIED | No source found |
| 11 | `refundType: ORIGIN_CHAIN` with `refundTo` an ETH, SOL or BTC address is accepted. The refund applies when the deposit is under `minAmountIn`, the swap does not complete by `deadline`, or there is an excess above `amountIn`. Quotes show `refundFee` (e.g. `35000000000000` wei for ETH, `120047` for SOL, `1900` for BTC). | VERIFIED (schema text and quote fields); no refund executed | OpenAPI `swapType` and `refundType` text; dry quotes |
| 12 | `refundType: INTENTS` refunds into an Intents account instead. | VERIFIED (schema) | OpenAPI |
| 13 | `recipientType: DESTINATION_CHAIN` means a real NEAR account receives the token. `recipientType: INTENTS` means the funds stay inside the Intents contract as an `mt` balance. In that case there is no `ft_on_transfer` and the msg path does not apply. | VERIFIED (schema); a dry quote with INTENTS plus `customRecipientMsg` was also accepted, with no evidence the msg is used | OpenAPI; dry quote |
| 14 | A dry quote to a non-existent NEAR account failed with HTTP 400 `Internal server error`. The same request to an existing account (`aurora.near`) succeeded. So deploy the sale account before generating quotes. | VERIFIED (observed). The reason (existence check vs. storage check) is UNVERIFIED | Dry quotes |
| 15 | Storage registration of the sale contract on `wrap.near` and USDC is the integrator's job. `FtWithdraw.storage_deposit` exists for Verifier users, but the 1Click request has no such field. Pre-register with `storage_deposit(sale, registration_only=true)` on each token. | VERIFIED that the 1Click request has no field; whether 1Click auto-registers is UNVERIFIED | OpenAPI; `FtWithdraw` |
| 16 | Fees: every dry quote echoed `appFees: [{recipient: 5880ad...47dd, fee: 20}]`, i.e. 20 bps (0.2%) added without a JWT. | VERIFIED | Dry quote responses |
| 17 | Extra `withdrawFee`. A `wrap.near` destination with `customRecipientMsg` showed `withdrawFee: "1250000000000000000000"` (0.00125 wNEAR). Some no-msg and USDC quotes showed `"0"`. | VERIFIED (observed) | Dry quotes |
| 18 | `swapType: EXACT_OUTPUT` fixes `amountOut`. A dry quote for exactly 5000000 USDC (5 USDC) returned `amountOut: "5000000"` and `amountIn` with slippage buffer. Surplus is refunded to `refundTo`. This lets the sale know exactly how much `ft_on_transfer` will deliver. | VERIFIED (quote); refund of surplus UNVERIFIED in practice | OpenAPI `swapType`; dry quote |
| 19 | Memo or `depositMemo` is a deposit-side field only (e.g. Stellar-style chains). It is not carried to the NEAR destination and cannot hold the ciphertext. | VERIFIED | OpenAPI `depositMode` and `depositMemo` |
| 20 | The deposit-address flow. A non-dry quote returns `depositAddress` on the origin chain, plus `deadline` and `timeWhenInactive`. The user sends exactly the quoted amount to it, optionally calling `POST /v0/deposit/submit` with the tx hash, and the app polls `GET /v0/status?depositAddress=...`. | VERIFIED (schema, dry-run field list); non-dry not exercised | OpenAPI `QuoteRequest.dry` text, `/v0/deposit/submit` and `/v0/status` paths |
| 21 | The status response includes `destinationChainTxHashes` and the refund type. Use it to show "bid landed" and to tie a bid to a NEAR tx. | VERIFIED (schema) | OpenAPI lines ~2044 onward |

## 2. Exact request shape

Verified accepted by a dry quote (HTTP 201). Change `dry` to `false` for a real quote (needs no JWT, but incurs the 0.2% fee on a real swap).

```
POST https://1click.chaindefuser.com/v0/quote
content-type: application/json

{
  "dry": true,
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 100,
  "originAsset": "nep141:sol.omft.near",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount": "5000000",
  "refundTo": "<bidder SOL address>",
  "refundType": "ORIGIN_CHAIN",
  "recipient": "<sale contract account id>.near",
  "recipientType": "DESTINATION_CHAIN",
  "customRecipientMsg": "<base64url(ciphertext||commit||nonce||bidder_refund_info)>, at most 1024 chars",
  "deadline": "2026-11-11T20:00:00.000Z"
}
```

Notes:
- `deadline` must be ISO 8601 and in the future. The `.000Z` form was used in all successful dry quotes. (Early failures were caused by a non-existent recipient, not the timestamp format.)
- For ETH use `originAsset: nep141:eth.omft.near` (ETH on Ethereum mainnet). For Base, Arbitrum and others, use the chain-specific asset id from `/v0/tokens`. For BTC use `nep141:btc.omft.near`.
- The destination can be `nep141:wrap.near` (24 decimals) as well.
- Do not send `customRecipientMsg: ""`. Per the docs an empty string still triggers `ft_transfer_call` with no refund protection.
- Prefer `EXACT_OUTPUT` so the sale receives an exact, predictable amount. With `EXACT_INPUT`, `amountOut` varies with slippage and the committed size could mismatch what `ft_on_transfer` sees.

## 3. Contract-side hooks SealedLaunch should expose

```rust
// NEP-141 receiver. Called by the token contract (wrap.near or the USDC token)
// via the Verifier's ft_transfer_call.
fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>
```

Rules:

1. Only accept `env::predecessor_account_id()` in an allowlist of sale tokens (`wrap.near`, USDC). Reject (return `amount`) for anything else.
2. Treat `sender_id` as a transport identity, not the bidder. Optionally record it and log whether it equals the expected Verifier (`intents.near`). Do not make authorization decisions on it.
3. Decode `msg` as `{v, sale_id, ciphertext, commit, refund_account}` (base64url or borsh). Verify `sale_id` and that the sale is in the bidding window and the commit has the expected length.
4. Do the whole thing in one call, with no promises beyond the required `PromiseOrValue::Value`. Return `U128(0)` (all used) after storing the sealed bid. This keeps within the 50 TGas default.
5. Never return the full amount to "reject" a bid after the auction decision is made. By evidence #9, that sends funds to 1Click's internal Intents balance, not to the bidder. Instead:
   - Accept every transfer from an allowed token.
   - If `msg` is malformed or the window is closed, store it as `Unclaimed{amount, token, raw_msg_hash, refund_account_if_parseable}`.
   - Expose `claim_refund(raw_msg)` for the bidder to pull back funds to a NEAR account. A bad bidder pays gas and the stake is never lost.
6. Bidder-bound refunds on non-win: `refund_account` inside `msg` must be a NEAR account (the bidder's NEAR address, or an Intents account). Refunding to the origin chain after a successful deposit would need Chain Signatures or a second 1Click quote (NEAR to origin chain); neither is verified here.
7. Idempotency: key bids by `commit` so a replayed `msg` cannot duplicate a bid.
8. Anti-spoof: because `msg` is unauthenticated, identity-bearing parts (bidder pubkey) must be bound inside the ECIES plaintext, which the TEE verifies. A third party who copies someone's `msg` only funds that bid; it does not let them claim the refund if `refund_account` is committed inside the ciphertext hash.
9. Storage: pre-register the sale contract with `storage_deposit` on each accepted token (evidence #15) before opening bidding.
10. Provide a view `bid_status(commit)` and an event `bid_received{commit, amount, token}` so the UI can poll after `GET /v0/status`.

## 4. Fallback if single-step proves unreliable

| Option | Flow | Hackathon feasibility |
|---|---|---|
| A (recommended fallback) | 1Click `recipient` = the bidder's own NEAR account, no `customRecipientMsg`. Then the bidder's wallet signs `ft_transfer_call(sale, amount, msg)` on NEAR. | High. Plain `ft_transfer`, standard NEAR wallet, `sender_id` is the real bidder. The cost is a second signature and a NEAR wallet. |
| B | `recipientType: INTENTS`, recipient is the bidder's Intents account. The bidder then signs a Verifier `ft_withdraw` intent with `msg` to the sale. | Medium. Needs intent signing (NEP-413 / ed25519 payload) and a relay; more moving parts. |
| C | `mt_on_transfer` receiver (Verifier `mt_transfer_call` into the sale contract). | Low. `mt_on_transfer` is a different interface; not researched here and would need new contract plumbing. UNVERIFIED. |
| D | Relayer takes a signed bid and the 1Click delivery separately. | Medium-low. Introduces a trusted party. |

Recommendation: build A as the guaranteed demo (it needs no mainnet 1Click msg path). Implement the single-step `customRecipientMsg` path behind a feature flag and test with ~1 USDC. Claim it in the README only after one successful mainnet run (the original design notes already said to hold this back unless it runs).

## 5. Open items to close before claiming mainnet bidding

1. Non-dry quote and a real small swap with `customRecipientMsg` to confirm `ft_on_transfer` receives it (spend about 1 USD).
2. Confirm the Verifier account id (`intents.near`) and the exact `sender_id` seen.
3. Confirm storage-registration behavior: does the quote or swap fail if the sale is unregistered on the token?
4. Confirm what 1Click does with Intents-balance refunds after a failed `ft_on_transfer`.
5. Confirm the real fee structure (0.2% app fee, `withdrawFee`, `refundFee`) on a live deposit.
