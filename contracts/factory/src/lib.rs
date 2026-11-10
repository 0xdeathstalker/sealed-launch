//! SealedLaunch factory (SPEC v1.1 section 6).
//!
//! Keyless-by-construction design: the sale sub-account is created in ONE batch
//! (CreateAccount, Transfer, DeployContract, FunctionCall init) that contains NO AddKey action,
//! so the account never has an access key at any point. (A parent cannot delete a child's
//! keys from outside anyway: DeleteKey requires predecessor == account.) This is strictly
//! stronger than "create then DeleteKey" and has no window in which a key exists.
//!
//! Flow:
//!   create_sale -> [batch create+deploy+init] -> on_created -> outlayer.request_execution(derive_pubkey)
//!   -> on_pk -> sale.set_pubkey(pk) -> on_pk_set -> status Ready
//!
//! Failure handling:
//!   * batch fails (atomic, nothing created)  -> name released, full attached deposit refunded to creator
//!   * derive fails / returns null / bad pk   -> sale exists, keyless, status AwaitingPk (unusable: the
//!     sale has no pk so it must refuse bids); anyone may `retry_pk(name)` with a deposit
//!   * set_pubkey fails                       -> same, AwaitingPk
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

const SALE_WASM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/sale.wasm"));
include!(concat!(env!("OUT_DIR"), "/placeholder.rs"));

const INIT_GAS: Gas = Gas::from_tgas(60);
const ON_CREATED_GAS: Gas = Gas::from_tgas(170);
const OUTLAYER_GAS: Gas = Gas::from_tgas(100);
const ON_PK_GAS: Gas = Gas::from_tgas(60);
const SET_PK_GAS: Gas = Gas::from_tgas(15);
const ON_PK_SET_GAS: Gas = Gas::from_tgas(20);
/// create_sale own work (10) + init (60) + on_created (170) + margin
const MIN_CREATE_GAS: Gas = Gas::from_tgas(260);
const MIN_RETRY_GAS: Gas = Gas::from_tgas(200);
const MAX_NAME_LEN: usize = 40;

#[near(serializers=[json])]
#[derive(Clone)]
pub struct CreateParams {
    pub name: String,
    pub symbol: String,
    pub token_name: String,
    pub icon: Option<String>,
    pub token_decimals: u8,
    pub auction_supply: U128,
    pub lp_token_reserve: U128,
    pub creator_supply: U128,
    pub reserve_price: U128,
    pub min_size: U128,
    pub bid_fee: U128,
    pub payment_token: Option<AccountId>,
    pub bid_end_ms: U64,
    pub challenge_secs: u32,
    pub lp_bps: u16,
    pub vesting_secs: u64,
    pub outlayer_project: String,
    pub code_hash: String,
    pub max_bids: u32,
}

#[near(serializers=[json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SaleStatus {
    /// create batch in flight (name reserved)
    Creating,
    /// account exists, keyless, initialised, but pk_sale not (yet) installed: UNUSABLE
    AwaitingPk,
    /// pk_sale installed
    Ready,
}

#[near(serializers=[json, borsh])]
#[derive(Clone)]
pub struct SaleRecord {
    pub account: AccountId,
    pub creator: AccountId,
    pub outlayer_project: String,
    pub status: SaleStatus,
    pub pubkey: Option<String>,
    pub created_ms: u64,
}

#[near(serializers=[json])]
pub struct CreateResult {
    pub ok: bool,
    pub status: Option<SaleStatus>,
    pub sale: Option<AccountId>,
    pub pubkey: Option<String>,
    pub message: String,
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Names,
    Records,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    outlayer: AccountId,
    /// deposit forwarded to outlayer for derive_pubkey (excess is refunded to this contract)
    outlayer_deposit: NearToken,
    /// extra storage funding on top of wasm bytes * byte cost
    storage_buffer: NearToken,
    names: Vector<String>,
    records: IterableMap<String, SaleRecord>,
    defaults: SaleDefaults,
}

/// Factory-controlled wiring passed to every sale's `new` (INTEGRATION.md: sale InitParams
/// has fields the SPEC CreateParams does not).
#[near(serializers=[json, borsh])]
#[derive(Clone)]
pub struct SaleDefaults {
    pub finalize_timeout_secs: u64,
    pub recompute_cap: u32,
    pub ref_exchange: Option<AccountId>,
    pub wnear: Option<AccountId>,
}

impl Default for SaleDefaults {
    fn default() -> Self {
        Self {
            finalize_timeout_secs: 3600,
            recompute_cap: 200,
            ref_exchange: Some("ref-finance-101.testnet".parse().unwrap()),
            wnear: Some("wrap.testnet".parse().unwrap()),
        }
    }
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId, outlayer: AccountId, outlayer_deposit: NearToken, storage_buffer: NearToken) -> Self {
        Self {
            owner,
            outlayer,
            outlayer_deposit,
            storage_buffer,
            names: Vector::new(Key::Names),
            records: IterableMap::new(Key::Records),
            defaults: SaleDefaults::default(),
        }
    }

    /// Owner only. Applies to sales created afterwards.
    pub fn set_sale_defaults(&mut self, defaults: SaleDefaults) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(defaults.recompute_cap <= 200, "recompute_cap <= 200");
        self.defaults = defaults;
    }

    pub fn get_sale_defaults(&self) -> SaleDefaults {
        self.defaults.clone()
    }

    // ---------------------------------------------------------------- create

    #[payable]
    pub fn create_sale(&mut self, p: CreateParams) -> Promise {
        require!(!IS_PLACEHOLDER, "factory was built with a placeholder sale wasm");
        require!(env::prepaid_gas() >= MIN_CREATE_GAS, "attach at least 260 Tgas");
        let attached = env::attached_deposit();
        let need = self.required_deposit();
        require!(attached >= need, format!("attach at least {} yocto (see get_required_deposit)", need.as_yoctonear()));
        Self::validate(&p);

        let sale_id = self.sale_id_for(&p.name);
        require!(self.records.get(&p.name).is_none(), "sale name already taken");
        let creator = env::predecessor_account_id();
        self.names.push(p.name.clone());
        self.records.insert(
            p.name.clone(),
            SaleRecord {
                account: sale_id.clone(),
                creator: creator.clone(),
                outlayer_project: p.outlayer_project.clone(),
                status: SaleStatus::Creating,
                pubkey: None,
                created_ms: env::block_timestamp_ms(),
            },
        );

        let storage_funding = attached.saturating_sub(self.outlayer_deposit);
        let init_args = self.init_args(&p, &creator);
        // NO AddKey anywhere: the account is keyless from its first block.
        Promise::new(sale_id)
            .create_account()
            .transfer(storage_funding)
            .deploy_contract(SALE_WASM.to_vec())
            .function_call("new".to_string(), init_args, NearToken::from_yoctonear(0), INIT_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_CREATED_GAS)
                    .on_created(p.name, creator, attached),
            )
    }

    #[private]
    pub fn on_created(&mut self, name: String, creator: AccountId, attached: NearToken) -> PromiseOrValue<CreateResult> {
        if env::promise_result_checked(0, 1024).is_err() {
            // The batch is atomic: nothing was created. Release the name and refund.
            self.remove_record(&name);
            let _ = Promise::new(creator).transfer(attached);
            return PromiseOrValue::Value(CreateResult {
                ok: false,
                status: None,
                sale: None,
                pubkey: None,
                message: "sale account creation/init failed; name released, deposit refunded".into(),
            });
        }
        let mut rec = self.records.get(&name).cloned().expect("record");
        rec.status = SaleStatus::AwaitingPk;
        let (sale, project) = (rec.account.clone(), rec.outlayer_project.clone());
        self.records.insert(name.clone(), rec);
        PromiseOrValue::Promise(self.request_pk(name, sale, project, self.outlayer_deposit))
    }

    /// Re-request pk derivation for a sale stuck in AwaitingPk. Anyone may call, paying the outlayer deposit.
    #[payable]
    pub fn retry_pk(&mut self, name: String) -> Promise {
        require!(env::prepaid_gas() >= MIN_RETRY_GAS, "attach at least 200 Tgas");
        require!(env::attached_deposit() >= self.outlayer_deposit, "attach outlayer deposit");
        let rec = self.records.get(&name).expect("no such sale");
        require!(rec.status == SaleStatus::AwaitingPk, "sale is not awaiting pk");
        self.request_pk(name, rec.account.clone(), rec.outlayer_project.clone(), env::attached_deposit())
    }

    #[private]
    pub fn on_pk(&mut self, name: String) -> PromiseOrValue<CreateResult> {
        let rec = self.records.get(&name).cloned().expect("record");
        let fail = |msg: &str| {
            PromiseOrValue::Value(CreateResult {
                ok: false,
                status: Some(SaleStatus::AwaitingPk),
                sale: Some(rec.account.clone()),
                pubkey: None,
                message: format!("{msg}; sale is keyless but UNUSABLE until retry_pk succeeds"),
            })
        };
        let bytes = match env::promise_result_checked(0, 4096) {
            Ok(b) => b,
            Err(_) => return fail("outlayer derive_pubkey call failed"),
        };
        let Some(pk) = parse_pubkey(&bytes) else { return fail("outlayer returned no valid pubkey") };
        PromiseOrValue::Promise(
            Promise::new(rec.account)
                .function_call(
                    "set_pubkey".to_string(),
                    near_sdk::serde_json::json!({ "pubkey": pk }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    SET_PK_GAS,
                )
                .then(Self::ext(env::current_account_id()).with_static_gas(ON_PK_SET_GAS).on_pk_set(name, pk)),
        )
    }

    #[private]
    pub fn on_pk_set(&mut self, name: String, pk: String) -> CreateResult {
        let mut rec = self.records.get(&name).cloned().expect("record");
        if env::promise_result_checked(0, 1024).is_err() {
            return CreateResult {
                ok: false,
                status: Some(rec.status),
                sale: Some(rec.account),
                pubkey: None,
                message: "sale.set_pubkey failed; sale is keyless but UNUSABLE until retry_pk succeeds".into(),
            };
        }
        rec.status = SaleStatus::Ready;
        rec.pubkey = Some(pk.clone());
        let sale = rec.account.clone();
        self.records.insert(name, rec);
        CreateResult { ok: true, status: Some(SaleStatus::Ready), sale: Some(sale), pubkey: Some(pk), message: "ready".into() }
    }

    // ----------------------------------------------------------------- views

    pub fn get_sale_account(&self, name: String) -> AccountId {
        self.records.get(&name).expect("no such sale").account.clone()
    }

    pub fn get_sale(&self, name: String) -> Option<SaleRecord> {
        self.records.get(&name).cloned()
    }

    /// Accounts of sales that exist on chain (status AwaitingPk or Ready), in creation order.
    /// `from` indexes the creation-order list of names (including names whose creation failed and were removed: they are skipped).
    pub fn list_sales(&self, from: u32, limit: u32) -> Vec<AccountId> {
        self.names
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .filter_map(|n| self.records.get(n))
            .filter(|r| r.status != SaleStatus::Creating)
            .map(|r| r.account.clone())
            .collect()
    }

    pub fn get_sales_count(&self) -> u32 {
        self.names.len()
    }

    pub fn get_required_deposit(&self) -> NearToken {
        self.required_deposit()
    }

    /// sha256 of the embedded sale wasm (hex)
    pub fn get_sale_code_hash(&self) -> String {
        hex(&env::sha256(SALE_WASM))
    }

    pub fn is_placeholder_build(&self) -> bool {
        IS_PLACEHOLDER
    }

    // ----------------------------------------------------------------- owner

    /// Withdraw accumulated outlayer refunds / surplus. Never touches sale accounts.
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        Promise::new(self.owner.clone()).transfer(amount)
    }

    // -------------------------------------------------------------- internal

    fn required_deposit(&self) -> NearToken {
        let storage = env::storage_byte_cost().saturating_mul(SALE_WASM.len() as u128);
        storage.saturating_add(self.storage_buffer).saturating_add(self.outlayer_deposit)
    }

    /// Args for the sale's `#[init] new(p: InitParams)`: CreateParams (minus `name`) plus factory wiring.
    fn init_args(&self, p: &CreateParams, creator: &AccountId) -> Vec<u8> {
        use near_sdk::serde_json::{json, Value};
        let mut v: Value = near_sdk::serde_json::to_value(p).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("name");
        o.insert("creator".into(), json!(creator));
        o.insert("factory".into(), json!(env::current_account_id()));
        o.insert("outlayer".into(), json!(self.outlayer));
        o.insert("finalize_timeout_secs".into(), json!(self.defaults.finalize_timeout_secs));
        o.insert("recompute_cap".into(), json!(self.defaults.recompute_cap));
        o.insert("reveal_secs".into(), json!(0));
        o.insert("reveal_bond".into(), json!("0"));
        o.insert("ref_exchange".into(), json!(self.defaults.ref_exchange));
        o.insert("wnear".into(), json!(self.defaults.wnear));
        json!({ "p": v }).to_string().into_bytes()
    }

    fn sale_id_for(&self, name: &str) -> AccountId {
        format!("sale-{}.{}", name, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid sale name"))
    }

    fn remove_record(&mut self, name: &str) {
        self.records.remove(name);
        // keep `names` consistent: swap_remove changes order but lists skip missing names anyway
        if let Some(i) = self.names.iter().position(|n| n == name) {
            self.names.swap_remove(i as u32);
        }
    }

    fn request_pk(&self, name: String, sale: AccountId, project: String, deposit: NearToken) -> Promise {
        let secrets_account = project.split('/').next().unwrap_or("").to_string();
        let args = near_sdk::serde_json::json!({
            "source": {"Project": {"project_id": project, "version_key": null}},
            "resource_limits": {"max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60},
            "input_data": near_sdk::serde_json::json!({"action": "derive_pubkey", "sale": sale}).to_string(),
            "secrets_ref": {"profile": "default", "account_id": secrets_account},
            "response_format": "Json",
            "payer_account_id": null,
            "params": null
        });
        Promise::new(self.outlayer.clone())
            .function_call("request_execution".to_string(), args.to_string().into_bytes(), deposit, OUTLAYER_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_PK_GAS).on_pk(name))
    }

    fn validate(p: &CreateParams) {
        let n = &p.name;
        require!(!n.is_empty() && n.len() <= MAX_NAME_LEN, "name length 1..=40");
        require!(
            n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
            "name must match [a-z0-9_-]+"
        );
        require!(!n.starts_with(['-', '_']) && !n.ends_with(['-', '_']), "name must not start/end with - or _");
        require!(p.token_decimals <= 24, "token_decimals <= 24");
        require!(p.lp_bps <= 10_000, "lp_bps <= 10000");
        if p.lp_bps > 0 {
            let x = p.auction_supply.0.checked_mul(p.lp_bps as u128).expect("overflow");
            require!(p.lp_token_reserve.0 >= x / 10_000 + u128::from(x % 10_000 != 0), "lp_token_reserve < ceil(auction_supply * lp_bps / 10000)");
        }
        require!(p.max_bids >= 1 && p.max_bids <= 65_536, "max_bids in 1..=65536");
        require!(p.auction_supply.0 >= 1, "auction_supply >= 1");
        require!(p.reserve_price.0 >= 1, "reserve_price >= 1");
        require!(p.bid_end_ms.0 > env::block_timestamp_ms(), "bid_end_ms must be in the future");
        require!(p.outlayer_project.contains('/'), "outlayer_project must be <owner>/<project>");
        require!(p.code_hash.len() == 64 && p.code_hash.bytes().all(|b| b.is_ascii_hexdigit()), "code_hash must be 64 hex chars");
    }
}

fn parse_pubkey(bytes: &[u8]) -> Option<String> {
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(bytes).ok()?;
    let s = v.get("pubkey")?.as_str()?.to_lowercase();
    let ok = s.len() == 66 && (s.starts_with("02") || s.starts_with("03")) && s.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then_some(s)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
