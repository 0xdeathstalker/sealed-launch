# sl-worker: SealedLaunch OutLayer TEE worker

Implements SPEC.md section 5 (v1.1). Actions `derive_pubkey` and `clear`. Crate depends on `../clearing` (`sealed-clearing`). Target `wasm32-wasip1`, about 375 KB.

## Input / output

```
derive_pubkey: {"action":"derive_pubkey","sale":"<sale account>"}            -> {"pubkey":"<33-byte compressed secp256k1 hex>"}
clear:         {"action":"clear",
                "params":{"sale_id","supply","reserve","token_decimals","min_size","bid_end_ms","code_hash"},
                "entries":[{"bidder","commit","deposit","ciphertext" (hex) | "ciphertext_b64"}]}
            -> {sale_id, input_hash, code_hash, p_star, sold, burned, raise, alloc_root, leaf_count, plaintexts:[{price,size,salt}|null]}
```
u128 values are decimal strings, `bid_end_ms` is a JSON number (unix ms, same as `create_sale`). Errors are returned as `{"error":"..."}` (process exit 0, so the sale's `on_clear` must treat a missing `p_star` / any `error` key as a failed run and allow retry).

Key: `HKDF-SHA256(master=PROTECTED_SL_MASTER, salt=none, info="sale:<sale account>")` -> secp256k1 secret. Ciphertexts are eciesjs 0.4 / Rust `ecies` 0.2 compatible. A ciphertext that fails to decrypt, or decrypts to something other than exactly 64 bytes, becomes `plaintext = None`.

## Decryption-oracle guard (mandatory, runs before the master secret or any ciphertext is touched)

- `derive_pubkey`: `NEAR_PREDECESSOR_ID` must be the sale, or the sale's parent account (the factory; sale = `<label>.<factory>`).
- `clear`: `NEAR_PREDECESSOR_ID == params.sale_id` exactly (and `sale`, if given, must equal it); `NEAR_BLOCK_TIMESTAMP` (nanoseconds, per OutLayer docs) `>= bid_end_ms * 1_000_000`; `bid_end_ms == 0`, an empty/zero/unparsable timestamp, or an empty predecessor are all refused.
- `bid_end_ms` comes from the input. This is sound only because the predecessor check means the input can only come from the sale contract itself, which must pass the `bid_end_ms` it stored at `create_sale`. The sale's `finalize` MUST build `input_data` from its own state, never from caller args.
- `code_hash` in the output is an echo of `params.code_hash`: a WASM cannot know its own sha256 and OutLayer sets no env var for it. The real binding is the secret's `--build` lock plus the attested `wasm_hash` of the execution (see RESULTS.md section b). Do not treat the echoed field as proof by itself.
- Defense in depth, not implemented here: OutLayer's manifest `callers` rule (contract-only) could be embedded as a wasm custom section.

## Build and test

```
cd outlayer-wasm
cargo test                                   # native; 10 tests
cargo build --release --target wasm32-wasip1
shasum -a 256 target/wasm32-wasip1/release/sl-worker.wasm   # = the build hash for --build and for sale init
# regenerate JS (eciesjs 0.4.x) fixtures, optional:
cd fixtures && npm install && node gen.mjs
```
Tests: guard accept/refuse matrix (wrong/empty/lookalike predecessor, early block time, ms-vs-ns confusion, bid_end 0, sale mismatch), garbage / wrong-sale / 63-byte / non-hex ciphertexts, all 11 `clearing/vectors.json` cases via a real ECIES round trip (outputs byte-equal), base64 transport, and ciphertexts produced by JS eciesjs 0.4.18 (`fixtures/fixtures.json`, with the pubkey derived independently by node `hkdfSync`).

The wasm hash depends on the toolchain; the sale must be created with the hash of the wasm that was actually uploaded. Record it, and rebuild reproducibly (pin rustc via a `rust-toolchain.toml`) before mainnet.

## Upload / deploy / lock the secret (testnet; needs `outlayer login testnet` for the owner account)

```
H=$(shasum -a 256 target/wasm32-wasip1/release/sl-worker.wasm | cut -d' ' -f1)
outlayer upload target/wasm32-wasip1/release/sl-worker.wasm
#  -> FastFS URL https://test.fastfs.io/<owner>/outlayer.testnet/$H.wasm
outlayer deploy sealedlaunch https://test.fastfs.io/<owner>/outlayer.testnet/$H.wasm --target wasm32-wasip1
outlayer secrets set --generate PROTECTED_SL_MASTER:hex32 --project <owner>/sealedlaunch --access allow-all --build $H
```
`--build $H` is mandatory: without it the project owner could ship a different version and read the master. `--access allow-all` is needed because the secret is judged against the tx signer and `finalize` is callable by anyone; the in-WASM guard is what closes the oracle. A new wasm version needs `outlayer secrets access --project <owner>/sealedlaunch --build <new hash>` before it can read the secret. Sale init must record project id and `$H`.

`request_execution` args from the sale: `source:{Project:{project_id:"<owner>/sealedlaunch",version_key:null}}`, `resource_limits:{max_instructions:>= 2e9 per 100 bids + headroom, max_memory_mb:128, max_execution_seconds:60}`, `input_data` (string), `secrets_ref:{profile:"default",account_id:"<owner>"}`, `response_format:"Json"`.

## Live testnet verification (project `deathstalker-sl.testnet/sealedlaunch`, build `607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6`)

Via the spike's `probe.deathstalker-sl.testnet` contract as predecessor. See the report for tx ids and numbers. `fixtures/live-input.mjs` builds a `clear` input for a given sale pubkey.
