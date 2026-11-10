# SealedLaunch factory: status notes

Crate: `contracts/factory/` (near-sdk 5.x, standalone, own `[workspace]`). Intended parent: `sealedlaunch.deathstalker-sl.testnet`. NOT deployed.

## Design decision: keyless by construction (deviates from SPEC wording)
SPEC says "create, deploy, init, then DeleteKey on all keys". NEAR forbids a parent from deleting a child's keys
(DeleteKey needs predecessor == the account), and a create-then-delete flow has a window where a key exists.
Instead `create_sale` sends ONE atomic batch `CreateAccount, Transfer, DeployContract, FunctionCall(init)` with
**no AddKey**. The sale account therefore never has any key. Zero keys is checked in the sandbox test with
`view_access_keys` (and by `scripts/verify_keyless.sh <acct>` against RPC).

## Flow and failure handling
1. `create_sale(p)` (payable, >=260 Tgas): validates, reserves name (status `Creating`), sends the batch, then `on_created`.
2. Batch failed (e.g. sale `init` panics): atomic, nothing exists. Name released, full deposit refunded to the creator. Tested.
3. Batch ok: status `AwaitingPk`; factory calls `outlayer.request_execution` (`derive_pubkey`, `sale` = sale account, factory is predecessor), then `on_pk`, then `sale.set_pubkey({pk})`, then `on_pk_set` -> `Ready` and `pk` stored.
4. derive returns null / junk / call fails / `set_pubkey` fails: sale stays keyless and `AwaitingPk` (unusable; sale must refuse bids without a pk). Anyone can call `retry_pk(name)` with >= outlayer_deposit and >= 200 Tgas. Tested (mock failures).
- `create_sale` returns `CreateResult {ok, status, sale, pubkey, message}`.
- Views: `get_sale_account(name)` (panics if unknown), `get_sale(name)`, `list_sales(from, limit)` (sales that exist on chain), `get_sales_count`, `get_required_deposit`, `get_sale_code_hash` (sha256 of embedded sale wasm), `is_placeholder_build`.
- Required deposit = storage_byte_cost * sale_wasm_len + storage_buffer + outlayer_deposit. Everything except `outlayer_deposit` goes to the sale account. OutLayer refunds unused deposit to the factory; owner pulls it with `withdraw`.
- Init args: `new(owner, outlayer, outlayer_deposit, storage_buffer)`; `outlayer` is configurable so tests use a mock.

## INTEGRATION POINT with the sale crate (contracts/sale/) - the sale agent must provide
- `#[init] fn init(p: CreateParams, creator: AccountId)` called by the factory in the create batch. Factory = `env::predecessor_account_id()` at init; store it. `p` JSON is exactly SPEC section 6 `CreateParams` (U128/U64 as strings, `outlayer_project` = `<owner>/<project>`).
- `fn set_pubkey(&mut self, pk: String)`: factory-only, once, `pk` = 66-char lowercase hex compressed secp256k1 (factory already validated shape). Before it is set the sale MUST refuse `bid`/`finalize` (gives "unusable-but-keyless").
- The sale must fit init in 60 Tgas (factory attaches `INIT_GAS` = 60 Tgas; mint/ft setup only).
- The sale wasm is embedded by `build.rs`: `$SALE_WASM_PATH`, else `../sale/res/*.wasm`, else `../sale/target/near/*.wasm`, else an 8-byte placeholder (then `create_sale` panics and `is_placeholder_build` = true). Build: `SALE_WASM_PATH=/abs/sale.wasm scripts/build.sh`.
- Requirement on the OutLayer worker: derive must allow predecessor == factory (SPEC section 5 amendment).

## Done (verified)
- `scripts/test.sh` (builds mocks, builds factory embedding the MOCK sale, runs near-workspaces sandbox tests): 5/5 pass: happy path (keyless, pk installed, outlayer args/predecessor/secrets owner, listing, duplicate name, non-factory set_pubkey rejected); init failure rolls back + refunds + name reusable; null/garbage pk -> AwaitingPk + keyless; set_pubkey failure -> AwaitingPk + keyless; input/deposit/gas validation.
- Mocks live in `tests/mocks/{sale,outlayer}` (test-only).
- `scripts/deploy.sh` (testnet only, refuses otherwise), `scripts/build.sh`, `scripts/verify_keyless.sh`.

## Not done / caveats
- Not tested against the real sale wasm (not present when written) nor the real `outlayer.testnet` (mock only). The real response shape is assumed from the spike: callback bytes `{"pubkey":"02.."}`. Gas constants for the OutLayer hop (100 Tgas call, 60 Tgas callback) are estimates, not measured on testnet; the whole chain must fit in 300 Tgas.
- `deploy.sh` never run; check the `near` CLI syntax before use. It does not set up OutLayer secrets (`--build` lock) or the project.
- With a real (~300 KB+) sale wasm `get_required_deposit` will be ~3+ NEAR plus buffer.
- Validation of economics (supply sums etc.) is left to the sale's `init`; factory only checks name, decimals<=24, lp_bps<=10000, max_bids in 1..=65536, supply/reserve >= 1, future deadline, project form, code_hash shape.
- Reaching the factory-side "Creating" state is transient; a stuck `Creating` (callback never runs) cannot happen short of gas exhaustion in `on_created`; if it did, the name would stay reserved (no admin recovery implemented).
- No git, GitHub, or mainnet actions were taken.
