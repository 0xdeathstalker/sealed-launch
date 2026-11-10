# OutLayer spike results (SealedLaunch)

Run on NEAR testnet, 10-11 Nov 2026, account `deathstalker-sl.testnet`. Every number below comes from a real transaction or a local run. Anything not measured is marked NOT VERIFIED.

## Verdict: GO (OutLayer is core)

| Gate item | Status |
|---|---|
| ECIES-to-enclave works (browser lib encrypts, only the WASM decrypts) | VERIFIED (see (a) for the browser caveat) |
| `yield_resume` callback carries enough output (200 bids) | VERIFIED |
| Cost at most 0.2 NEAR per 100-bid run | VERIFIED: 0.0039 NEAR net (about 50x under the gate) |

Open items that do not block the gate: on-chain attestation check (b), the decryption-oracle design issue, and timeout and liveness behaviour.

## What was built (all in `spike-outlayer/`)

- `wasm/`: `sl-spike`, a wasm32-wasip1 WASM (325 KB). It reads `PROTECTED_SL_MASTER` from the env and derives a secp256k1 key with HKDF-SHA256, `info = "sale:{account}"` (the private-dao-example pattern, Rust `ecies` 0.2 with libsecp256k1). It has two actions: `derive_pubkey` and `clear` (decrypts every ciphertext and returns the plaintexts plus `input_hash`).
- `probe/`: a NEAR contract (`probe.deathstalker-sl.testnet`). It calls `outlayer.testnet.request_execution` and records what its callback receives.
- `client/`: `local-test.mjs` and `gen-input.mjs`, which encrypt with `eciesjs`.
- Deployed to the project `deathstalker-sl.testnet/sl-spike`. The WASM is hosted on FastFS (`test.fastfs.io`), so no GitHub is involved. sha256 `02f6753d...094a9f`.

## (a) Per-sale pubkey and encrypting from the browser: VERIFIED (browser itself not run)

How the flow works:

1. **Generate the master secret.** `outlayer secrets set --generate PROTECTED_SL_MASTER:hex32 --project <owner>/<project>` makes a 32-byte secret inside the TEE. Its value is never visible. It is stored encrypted on `outlayer.testnet`. The docs say the keystore master comes from MPC CKD, but that is only the docs' claim. We did not inspect it. What we used is the `PROTECTED_*` secret path.
2. **Derive the sale pubkey.** The sale contract calls `request_execution` with `{"action":"derive_pubkey","sale":"<sale account>"}`. The callback returns `{"pubkey":"02..."}` (33-byte compressed secp256k1). It cost 0.0019 NEAR and took about 9 s. Tx `FN3U6gcctZGAs9yJJXgNbtTVkuWeA1EQZfQbJyH5zrSn`.
3. **Expose the pubkey to clients.** The sale contract stores `pk_sale` in its state. The browser reads it with a plain view call. OutLayer has no separate pubkey endpoint for this, and `outlayer.testnet` has no `get_keystore_pubkey` method (MethodNotFound).
4. **Encrypt to it.** The pubkey it returned was `029366bc...8814` for sale `sale-x.sealedlaunch.testnet`. I encrypted 10, 50, 100 and 200 bids with `eciesjs` 0.4 (Node) to that key. The on-chain TEE run decrypted all of them: `n_plain` equalled N in every run, with no failures.
5. **Garbage and wrong-sale ciphertexts.** A garbage ciphertext decrypts to `null`. This was shown locally, not on chain. A ciphertext for sale A did not decrypt under sale B's derived key (local test, `null`).

Caveats:
- I ran `eciesjs` in Node, not in a browser tab. It is the same library in the browser. A quick browser smoke test is still worth doing on day 1.
- One master secret serves all sales, with per-sale HKDF isolation. A compromise of the master exposes every sale. This is already noted in the spec.

"Only the attested WASM can decrypt" is enforced by a build lock, tested on chain:
- I ran `outlayer secrets access --access allow-all --build <sha256 of wasm>`.
- A non-owner signer (`probe.deathstalker-sl.testnet`) then ran the build and got the same pubkey, so anyone can trigger the run.
- I deployed a leaky WASM (`7908f931...`) as the new project version, which prints the env var. It was refused: "Access denied ... this secret is locked to build 02f6753d... and the running build is 7908f931...". Instructions used: 0.
- Without `--build`, the default row is `whitelist:<owner>`. With only that, the project owner could ship a new version and read the secret. **Always set `--build`.**
- This check is done by the keystore on the worker's word. The attestation doc says the keystore accepts the worker's claimed wasm hash on the trust of the worker's TEE session. So the trust anchor is the OutLayer TDX worker and keystore, not just the code hash.

**Design issue found (the decryption oracle).**
- The build-locked WASM decrypts whatever ciphertexts are in its `input_data`. Anyone who is allowed to run it can pass in a single bid's ciphertext and read the plaintext at any time.
- Mitigations to build:
  - Have the WASM refuse unless `NEAR_PREDECESSOR_ID` is the sale contract, and `NEAR_BLOCK_TIMESTAMP` is at least the deadline. The docs list both as env vars. Not verified by me.
  - Restrict secret readers with `--direct` / `--via <factory>`. Not tested.
  - Have the WASM fetch the bids itself from the sale contract by RPC. Not tested.
- Without one of these, the sealed-bid property does not hold.

## (b) Can the attestation be verified on chain: NOT VERIFIED on chain; the on-chain trust model is documented and checked

- The `yield_resume` payload (`ExecutionResponse`) has no quote and no attestation field. Its fields are `success`, `output`, `error`, `resources_used`, `compilation_note` and `refund_usd`.
- A callback therefore can only check `predecessor == outlayer.testnet` (in my probe it saw `probe...` itself, the self-call, with the data coming from `outlayer.testnet`). It cannot check a quote.
- On chain, only `worker.outlayer.testnet` (the operator account) can resolve executions. Its function-call keys are added only after `register_worker_key` verifies a TDX quote with dcap-qvl. All five measurements (MRTD, RTMR0-3) must be on an owner-approved list, which `get_approved_measurements` returns (4 entries on testnet). The register contract does not check anything about the per-execution quote.
- Per-execution TDX quotes exist and are public, off chain: `GET https://testnet-api.outlayer.ai/attestations/by-tx/{tx}`. I fetched one for the N=200 run: a 6676-char base64 quote, plus `input_hash`, `output_hash`, `wasm_hash`, `executed_wasm_sha256`, `project_id`, `request_id` and `transaction_hash`.
- The `output_hash` in the attestation (`053043bb...838e`) equals the sha256 my callback computed over the 35,556 bytes it received. So anyone can bind the on-chain output to the attested quote off chain. I did not verify the quote's Intel signature chain.
- Not attempted: submitting a quote to our contract and verifying it with dcap-qvl on chain. It is plausible, since the register contract does it, but it is not measured.
- Practical plan: pin the project ID and the WASM hash, accept only `outlayer.testnet`, and publish a verification script that checks the quote against `output_hash`. The spec's on-chain recomputation (the TEE trusted for privacy and liveness only) is what protects correctness.

## (c) Cost and latency: VERIFIED

All runs went through the probe contract, signed by `deathstalker-sl.testnet`. Limits were `max_instructions` 20e9 and `max_execution_seconds` 60, with a deposit of 0.01 to 0.8 NEAR (the unused part comes back).

Net cost is the OutLayer fee kept, plus all gas burnt across receipts.

| N bids | `input_data` bytes | callback output bytes | WASM instructions | WASM time | OutLayer fee | gas burnt | **net cost** | latency (tx to last receipt) |
|---|---|---|---|---|---|---|---|---|
| 10 | 4,904 | 1,915 | 63.5M | 561 ms | 0.00106 | 0.00157 | **0.0026 NEAR** | 10.3 s |
| 50 | 24,384 | 8,955 | 313M | 591 ms | 0.00106 | 0.00202 | **0.0031 NEAR** | 8.4 s |
| 100 | 48,734 | 17,756 | 626M | 638 ms | 0.00106 | 0.00288 | **0.0039 NEAR** | 8.0 s |
| 200 | 97,734 | 35,556 | 1,250M | 704 ms | 0.00107 | 0.00460 | **0.0057 NEAR** | 10.9 s |

- Latency is about 8 to 11 s from request tx to the `on_execution_response` receipt, and is independent of N, since WASM time is under 1 s. It is dominated by worker pickup and block time. The `near-cli` wall clock including finality was 15 to 18 s.
- The tx hashes for the runs are in `/private/tmp/claude-504/x/tx_f{10,50,100,200}.json` (scratch, not part of the deliverable). They are: N=10 `8PtT1Af9...`, N=50 `4YAzDwgp...`, N=100 `azYAbKcexp...`, N=200 `z6EkLg4NnH...`.
- Instruction cost per bid is about 6.3M. The **default `max_instructions` is 1e9**, so a 200-bid run with defaults fails: WASM trap at exactly 1e9, `output` is `null`, and I was charged the base fee of 0.00107 NEAR. Always set `max_instructions` explicitly. The hard cap is 500e9 instructions and 180 s.
- **Pricing from the chain** (`get_pricing_full`): base fee 0.001 NEAR, 1e-10 NEAR per million instructions, 1e-7 NEAR per ms. The deposit required is the estimate at your limits, and the excess is refunded.
- **Where the refund lands:** it goes to the predecessor (the calling contract), not the signer. The sale contract must be able to receive the refund and decide what to do with it. `payer_account_id` exists as a parameter. I did not test it.
- **`input_data` size limit:** no hard limit found in the contract source. Proven up to 97.7 KB.
  - Up to 32 KiB it is free.
  - Above that, each byte requires a refundable hold of 0.00001 NEAR (N=200 held about 0.65 NEAR, returned at settlement).
  - The callback gas reserve grows by 25 Mgas per byte over 32 KiB.
  - Input under 10 KB goes in the event log; above that, the worker reads it from contract state.
  - The practical ceiling is NEAR's 4 MiB transaction and args limit, which I did not test. Using base64 instead of hex for the ciphertexts would cut `input_data` by a third.
- **Gas gotcha for callers:** with 97 KB in the args, `300 Tgas` minus a 10 Tgas buffer failed ("Exceeded the prepaid gas") because the outgoing receipt is metered by size. A 70 Tgas buffer worked at 300 Tgas prepaid. A real contract should size its gas buffer from the payload length.

## (d) Does the callback carry all the plaintexts: VERIFIED

- My probe contract's `#[private]` callback received the full output via `promise_result` for N=200: 35,556 bytes, all 200 bids decrypted, JSON parsed fine, `n_bids` = `n_plain` = 200.
- Mechanism: `promise_yield_resume` is limited to 1024 bytes, so the worker stores large outputs in contract state and resumes with metadata only. `on_execution_response` then returns the stored bytes with `value_return`, and the caller's callback reads them as a normal promise result. The source shows this directly.
- Callback gas (parse the JSON, sha256, count) was 6.8 Tgas at N=200.
- A failed run (instruction limit, access denied) returns `null` to the caller. The sale callback must treat `null` as "run failed", then retry or refund.
- Not verified: the output size ceiling, the 200-block yield timeout path, and `cancel_stale_execution` (docs say 10 minutes).

## Access, signup and keys

For the on-chain testnet path, none of the following was needed: signup, dashboard account, API key, payment key, or any human action. A full-access ed25519 key for the testnet account was enough (`outlayer login testnet` imports it; I kept credentials in a scratch `OUTLAYER_HOME`, not in the repo). The CLI is `cargo install --git https://github.com/out-layer/outlayer-cli`, and the WASM goes up through FastFS with `outlayer upload` and `outlayer deploy <name> <url> --target wasm32-wasip1`.
- Payment keys are only for the HTTPS API (USDC), which I did not use.
- Mainnet: untested and out of scope.
- No secrets are committed. The only key used is in `~/.near-credentials`. The `probe` sub-account key sits in the macOS keychain (near-cli's `save-to-keychain`).

## Other findings and gotchas

- Use `wasm32-wasip1` binary targets; the old `code_source` JSON shape in the docs is outdated. The live `request_execution` args are `source: {"Project": {"project_id", "version_key"}}`, `resource_limits`, `input_data` (a string), `secrets_ref: {profile, account_id}`, `response_format: "Json"`, `payer_account_id`, `params`.
- Secret access is judged against the **signer** (the tx signer), not the predecessor. The `--direct` and `--via` flags change that. This matters for `finalize` being callable by anyone.
- Redeploying an already-uploaded version fails with "Version already exists". Use `outlayer versions activate <sha>`, which needs an `outlayer.toml`.
- Treat the `PROTECTED_SL_MASTER` secret in this spike as disposable. I printed no secrets, but the project's active version is reactivated to the original (the leaky one was only briefly active).

## Spend

About 0.105 NEAR net across the whole spike (all txs). That does not count the 2.2 NEAR used to create the `probe` sub-account (its balance includes the storage stake and the accumulated refunds, about 4.27 NEAR now), which can be reclaimed by deleting the account with `deathstalker-sl.testnet` as beneficiary. `deathstalker-sl.testnet` has about 5.62 NEAR.

## Recommended next steps

1. Make the WASM refuse inputs unless `NEAR_PREDECESSOR_ID` is the sale or factory contract and the block time is past the deadline (closes the decryption oracle), then verify that with a test.
2. Always create the secret with `--build <sha>` and record the project ID and WASM hash in each sale's init.
3. Set `max_instructions` to about 2e9 per 100 bids plus headroom.
4. Add the 200-block yield timeout and liveness test (what the callback sees when the worker never resumes).
5. Smoke-test `eciesjs` in a real browser tab against the live `pk_sale`.
