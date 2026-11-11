//! SealedLaunch sale contract (also the NEP-141 token). Normative spec: ../../SPEC.md (v1.1).
//!
//! Layout: lib.rs (state, bidding, finalize/on_clear, challenge, claim, refund, settle, fallback),
//! lp.rs (isolated Ref Finance LP promise chain), types.rs, util.rs.
#![allow(deprecated)]

mod lp;
mod types;
mod util;

pub use types::*;
use util::*;

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::impl_fungible_token_core;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, Gas, GasWeight, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use sealed_clearing as sc;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Max slots for which `on_clear` re-runs `clear` on-chain. See NOTES.md for the benchmark that set this.
pub const RECOMPUTE_CAP_MAX: u32 = 200;
const MAX_CT_BYTES: usize = 1024;
const NS: u64 = 1_000_000_000;
/// A request whose callback never ran (e.g. out of gas) can be re-issued after this long.
const STALE_NS: u64 = 600 * NS;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const PAYOUT_CB_GAS: Gas = Gas::from_tgas(10);
const SECRETS_PROFILE: &str = "default";

#[ext_contract(ext_ft)]
pub trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Sale {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    cfg: InitParams,
    status: Status,
    voided: bool,
    slots: Vector<Slot>,
    ciphertexts: LookupMap<u32, Vec<u8>>,
    plains: LookupMap<u32, PlainBid>,
    /// Payment-token units currently owed to bidders (deposits + bonds) and not yet paid out.
    escrow: u128,
    deposits_total: u128,
    fees_accrued: u128,
    fees_withdrawn: u128,
    pubkey: Option<Vec<u8>>,
    in_flight: bool,
    request_ts: u64,
    nonce: u64,
    clearing: Option<ClearingState>,
    challenge_end: u64,
    cleared_at: u64,
    claimed: LookupSet<AccountId>,
    failed_payouts: LookupMap<AccountId, u128>,
    failed_total: u128,
    vested_paid: u128,
    lp_status: LpStatus,
    commit_idx: LookupMap<[u8; 32], u32>,
    rejected: LookupMap<[u8; 32], String>,
    unclaimed: LookupMap<[u8; 32], Unclaimed>,
}

fn now() -> u64 {
    env::block_timestamp()
}

#[near]
impl Sale {
    #[init]
    pub fn new(p: InitParams) -> Self {
        require!(!env::state_exists(), "already initialized");
        require!(p.token_decimals <= 24, "decimals <= 24");
        require!(p.auction_supply.0 >= 1 && p.auction_supply.0 <= sc::MAX_SUPPLY, "bad auction_supply");
        require!(p.reserve_price.0 >= 1, "reserve >= 1");
        require!(p.lp_bps <= 10_000, "lp_bps <= 10000");
        require!(p.max_bids >= 1 && p.max_bids as usize <= sc::MAX_BIDS, "bad max_bids");
        require!(p.recompute_cap <= RECOMPUTE_CAP_MAX, "recompute_cap above RECOMPUTE_CAP_MAX");
        require!(unhex32(&p.code_hash).is_some(), "code_hash must be 32-byte hex");
        require!(p.bid_end_ms.0 * 1_000_000 > now(), "bid_end in the past");
        require!(p.outlayer_project.contains('/'), "outlayer_project = owner/name");
        if p.lp_bps > 0 {
            // sold <= auction_supply and tokens needed = sold * lp_bps / 10000 at ANY clearing price
            let need = p.auction_supply.0 * p.lp_bps as u128 / 10_000 + u128::from(p.auction_supply.0 * p.lp_bps as u128 % 10_000 != 0);
            require!(p.lp_token_reserve.0 >= need, "lp_token_reserve < ceil(auction_supply * lp_bps / 10000)");
            require!(p.ref_exchange.is_some(), "lp_bps > 0 needs ref_exchange");
            require!(p.payment_token.is_some() || p.wnear.is_some(), "NEAR sale with LP needs wnear");
        }
        let mode = p.mode.unwrap_or(Mode::Tee);
        if mode == Mode::Fallback {
            require!(p.payment_token.is_none(), "fallback mode is NEAR-only");
            require!(p.reveal_secs > 0, "reveal_secs > 0");
        }
        let total = p
            .auction_supply
            .0
            .checked_add(p.lp_token_reserve.0)
            .and_then(|x| x.checked_add(p.creator_supply.0))
            .expect("supply overflow");
        let me = env::current_account_id();
        let mut token = FungibleToken::new(b"t");
        token.internal_register_account(&me);
        token.internal_deposit(&me, total);
        FtMint { owner_id: &me, amount: U128(total), memo: Some("sale supply") }.emit();
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: p.token_name.clone(),
            symbol: p.symbol.clone(),
            icon: p.icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: p.token_decimals,
        };
        let pubkey = p.pubkey.as_ref().map(|s| unhex(s).filter(|v| v.len() == 33).expect("pubkey: 33-byte hex"));
        Self {
            token,
            metadata,
            cfg: p,
            status: Status::Bidding,
            voided: false,
            slots: Vector::new(b"s"),
            ciphertexts: LookupMap::new(b"c"),
            plains: LookupMap::new(b"p"),
            escrow: 0,
            deposits_total: 0,
            fees_accrued: 0,
            fees_withdrawn: 0,
            pubkey,
            in_flight: false,
            request_ts: 0,
            nonce: 0,
            clearing: None,
            challenge_end: 0,
            cleared_at: 0,
            claimed: LookupSet::new(b"d"),
            failed_payouts: LookupMap::new(b"f"),
            failed_total: 0,
            vested_paid: 0,
            lp_status: LpStatus::None,
            commit_idx: LookupMap::new(b"i"),
            rejected: LookupMap::new(b"r"),
            unclaimed: LookupMap::new(b"u"),
        }
    }

    /// Factory-only, once: record `pk_sale` (derived by an OutLayer `derive_pubkey` run).
    pub fn set_pubkey(&mut self, pubkey: String) {
        require!(env::predecessor_account_id() == self.cfg.factory, "factory only");
        require!(self.pubkey.is_none(), "pubkey already set");
        let v = unhex(&pubkey).filter(|v| v.len() == 33).expect("33-byte compressed pubkey hex");
        self.pubkey = Some(v);
    }

    // ============================================================== bidding (TEE mode)

    /// NEAR payment. attached = fee + deposit. Returns slot index.
    #[payable]
    pub fn bid(&mut self, ciphertext: String, commit: String) -> u32 {
        require!(self.cfg.payment_token.is_none(), "this sale takes a NEP-141 payment token");
        self.place_sealed(
            env::predecessor_account_id(),
            env::attached_deposit().as_yoctonear(),
            ciphertext,
            commit,
            None,
        )
    }

    /// NEP-141 payment path (also the Intents `ft_withdraw` path). NEVER panics, never makes cross-contract
    /// calls, returns U128(0) for the allowlisted payment token. Anything it cannot turn into a bid
    /// (malformed/late/unknown msg) is recorded as `Unclaimed` and pulled back via `claim_refund`.
    /// A transfer from a token other than `payment_token` is returned in full (U128(amount)).
    /// `sender_id` may be the Intents contract; the bidder is `msg.bidder` (bound into the commit).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if self.cfg.payment_token.as_ref() != Some(&token) {
            return PromiseOrValue::Value(amount);
        }
        let msg_key = msg_key(&sender_id, &token, &msg);
        let parsed = parse_ft_msg(&msg);
        let (commit_key, refund_account) = match &parsed {
            Some(m) => (
                unhex32(&m.commit),
                m.bidder.as_ref().or(m.refund_to.as_ref()).and_then(|a| a.parse::<AccountId>().ok()),
            ),
            None => (None, None),
        };
        let res = match parsed {
            None => Err("malformed msg".to_string()),
            Some(m) => self.try_ft_bid(&sender_id, amount.0, m),
        };
        match res {
            Ok(idx) => log!("EVENT_JSON:{{\"event\":\"bid_received\",\"idx\":{idx},\"amount\":\"{}\",\"token\":\"{token}\"}}", amount.0),
            Err(why) => {
                let mut u = self.unclaimed.get(&msg_key).cloned().unwrap_or(Unclaimed {
                    sender: sender_id.clone(),
                    token: token.clone(),
                    amount: 0,
                    refund_account,
                });
                u.amount = u.amount.saturating_add(amount.0);
                self.unclaimed.insert(msg_key, u);
                if let Some(c) = commit_key {
                    if self.commit_idx.get(&c).is_none() {
                        self.rejected.insert(c, why.clone());
                    }
                }
                log!("EVENT_JSON:{{\"event\":\"unclaimed\",\"sender\":\"{sender_id}\",\"amount\":\"{}\",\"why\":\"{why}\"}}", amount.0);
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Pull back an `Unclaimed` transfer. Pays the NEAR account named in the original msg (bidder, else
    /// refund_to) if there was one; otherwise only `sender_id` itself may claim, to `to` (default: sender).
    pub fn claim_refund(&mut self, sender_id: AccountId, token: AccountId, raw_msg: String, to: Option<AccountId>) -> Promise {
        let key = msg_key(&sender_id, &token, &raw_msg);
        let u = self.unclaimed.get(&key).cloned().unwrap_or_else(|| env::panic_str("no unclaimed record"));
        let dest = match &u.refund_account {
            Some(a) => a.clone(),
            None => {
                require!(env::predecessor_account_id() == sender_id, "only the sender can claim a msg without a NEAR refund account");
                to.unwrap_or(sender_id.clone())
            }
        };
        self.unclaimed.remove(&key);
        self.pay_out(dest, u.amount)
    }

    pub fn bid_status(&self, commit: String) -> BidStatus {
        let Some(c) = unhex32(&commit) else {
            return BidStatus { state: "unknown".into(), idx: None, reason: Some("bad commit".into()) };
        };
        if let Some(i) = self.commit_idx.get(&c) {
            return BidStatus { state: "accepted".into(), idx: Some(*i), reason: None };
        }
        match self.rejected.get(&c) {
            Some(r) => BidStatus { state: "unclaimed".into(), idx: None, reason: Some(r.clone()) },
            None => BidStatus { state: "unknown".into(), idx: None, reason: None },
        }
    }

    /// Before bid_end. Refunds the deposit (and fallback bond); the fee is kept. Slot becomes empty.
    pub fn cancel_bid(&mut self, idx: u32) -> PromiseOrValue<bool> {
        self.require_bidding_open();
        let mut s = self.slot(idx);
        require!(env::predecessor_account_id() == s.bidder, "only the bidder");
        require!(!s.cancelled, "already cancelled");
        let amt = s.deposit + s.bond;
        self.deposits_total -= s.deposit;
        self.escrow -= amt;
        self.commit_idx.remove(&s.commit);
        s.deposit = 0;
        s.bond = 0;
        s.commit = [0; 32];
        s.cancelled = true;
        let dest = Self::dest_of(&s);
        self.slots.replace(idx, s);
        self.ciphertexts.remove(&idx);
        log!("EVENT_JSON:{{\"event\":\"bid_cancelled\",\"idx\":{idx}}}");
        if amt == 0 {
            return PromiseOrValue::Value(true);
        }
        PromiseOrValue::Promise(self.pay_out(dest, amt))
    }

    /// NEAR payment: add attached deposit to an existing slot (commit/ciphertext unchanged).
    #[payable]
    pub fn top_up(&mut self, idx: u32) {
        require!(self.cfg.payment_token.is_none(), "use ft_transfer_call with {\"action\":\"top_up\"}");
        self.add_deposit(idx, &env::predecessor_account_id(), env::attached_deposit().as_yoctonear());
    }

    // ============================================================== finalize / on_clear

    /// Anyone, after bid_end. Attach NEAR for the OutLayer deposit: at least
    /// `get_finalize_deposit().required` (compute estimate at our resource limits + refundable hold
    /// on `input_data` beyond 32 KiB), `recommended` adds headroom. OutLayer refunds everything above
    /// its actual charge to `payer_account_id` = the caller. Prepaid gas: see `finalize_gas_needed`.
    #[payable]
    pub fn finalize(&mut self) -> Promise {
        require!(self.mode() == Mode::Tee, "fallback mode: use clear()");
        let t = now();
        require!(t >= self.bid_end_ns(), "bidding still open");
        require!(t < self.deadline_ns(), "finalize window passed: refund mode");
        let ok = match self.status {
            Status::Bidding => true,
            Status::Clearing => !self.in_flight || t > self.request_ts + STALE_NS,
            _ => false,
        };
        require!(ok, "not finalizable in this state");
        let n = self.slots.len();
        if n == 0 {
            // Nothing to decrypt: clear on-chain (everything burns at the reserve price).
            let r = sc::clear(&self.sc_params(), &[]).unwrap_or_else(|_| env::panic_str("clear failed"));
            self.accept_clearing(&r, true);
            return Promise::new(env::predecessor_account_id()).transfer(env::attached_deposit());
        }
        let input = self.clear_input();
        // OutLayer rejects (panics) below its estimate, and the attached NEAR of a failed receipt
        // goes back to the predecessor (this sale), not the caller. Enforce the minimum here so an
        // underpaid finalize fails before any state change and the caller keeps the deposit.
        let deposit = env::attached_deposit();
        let need = outlayer_required_deposit(input.len(), n);
        require!(
            deposit.as_yoctonear() >= need,
            format!(
                "attached deposit too low for OutLayer: need >= {need} yoctoNEAR for {n} bids / {} input bytes (see get_finalize_deposit); unused part is refunded to the caller",
                input.len()
            )
        );
        let (project_id, _) = self.cfg.outlayer_project.split_once('/').unwrap();
        let args = near_sdk::serde_json::json!({
            "source": {"Project": {"project_id": self.cfg.outlayer_project, "version_key": null}},
            "resource_limits": {
                "max_instructions": max_instructions(n),
                "max_memory_mb": 256,
                "max_execution_seconds": MAX_EXECUTION_SECONDS
            },
            "input_data": input,
            "secrets_ref": {"profile": SECRETS_PROFILE, "account_id": project_id},
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
            "params": null
        })
        .to_string()
        .into_bytes();

        let cb_gas = callback_gas(n as usize, n <= self.cfg.recompute_cap);
        let buffer = buffer_gas(args.len());
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        let reserved = cb_gas.saturating_add(buffer);
        require!(
            remaining.as_gas() >= reserved.as_gas() + Gas::from_tgas(30).as_gas(),
            format!("prepaid gas too low: need >= {} Tgas more", (reserved.as_gas() + Gas::from_tgas(30).as_gas()) / 1_000_000_000_000 + 1)
        );
        self.status = Status::Clearing;
        self.in_flight = true;
        self.request_ts = t;
        self.nonce += 1;
        let nonce = self.nonce;
        log!("EVENT_JSON:{{\"event\":\"finalize\",\"nonce\":{nonce},\"slots\":{n}}}");

        Promise::new(self.cfg.outlayer.clone())
            .function_call_weight(
                "request_execution".to_string(),
                args,
                deposit,
                remaining.saturating_sub(reserved),
                GasWeight(1),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(cb_gas).on_clear(nonce))
    }

    /// Callback of the OutLayer call. Non-panicking on bad results so `in_flight` always resets and
    /// `finalize` can be retried (a `null` result = failed run). Returns true iff accepted.
    #[private]
    pub fn on_clear(&mut self, nonce: u64) -> bool {
        if self.status != Status::Clearing || !self.in_flight || nonce != self.nonce {
            log!("on_clear ignored: stale (status={:?} in_flight={} nonce={} cur={})", self.status, self.in_flight, nonce, self.nonce);
            return false;
        }
        self.in_flight = false;
        if now() >= self.deadline_ns() {
            return self.reject("result after finalize deadline");
        }
        let bytes = match env::promise_result_checked(0, 4 * 1024 * 1024) {
            Ok(b) => b,
            Err(PromiseError::Failed) => return self.reject("outlayer call failed"),
            Err(_) => return self.reject("outlayer result unreadable"),
        };
        // Worker failures: `null`, {"error":...} (exit code 0), or anything without p_star = failed run (retryable).
        let v: near_sdk::serde_json::Value = match near_sdk::serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return self.reject("invalid TEE output (run failed)"),
        };
        if !v.is_object() || v.get("error").is_some() || v.get("p_star").is_none() {
            return self.reject("TEE run failed (null / error / no p_star)");
        }
        let out: ClearOutput = match near_sdk::serde_json::from_value(v) {
            Ok(o) => o,
            Err(_) => return self.reject("TEE output has wrong shape"),
        };
        // ---- binding checks
        if out.sale_id != env::current_account_id().as_str() {
            return self.reject("sale_id mismatch (replay?)");
        }
        // The worker's code_hash is only an echo of params.code_hash: sanity, NOT proof. Trust = OutLayer
        // --build lock on the secret + this callback only running from our own request to cfg.outlayer.
        if let Some(h) = &out.code_hash {
            if unhex32(h) != unhex32(&self.cfg.code_hash) {
                return self.reject("code_hash echo mismatch");
            }
        }
        let n = self.slots.len();
        let entries0 = self.entries_with(&vec![None; n as usize]);
        let ih = sc::input_hash(env::current_account_id().as_str(), &entries0);
        if unhex32(&out.input_hash) != Some(ih) {
            return self.reject("input_hash mismatch");
        }
        if out.plaintexts.len() != n as usize {
            return self.reject("plaintexts length mismatch");
        }
        let mut plains: Vec<Option<PlainBid>> = Vec::with_capacity(n as usize);
        for p in &out.plaintexts {
            plains.push(match p {
                None => None,
                Some(p) => match unhex32(&p.salt) {
                    Some(salt) => Some(PlainBid { price: p.price.0, size: p.size.0, salt }),
                    None => return self.reject("bad salt in plaintexts"),
                },
            });
        }
        let Some(alloc_root) = unhex32(&out.alloc_root) else {
            return self.reject("bad alloc_root");
        };
        let claimed = ClearingState {
            p_star: out.p_star.0,
            sold: out.sold.0,
            burned: out.burned.0,
            raise: out.raise.0,
            alloc_root,
            input_hash: ih,
            leaf_count: out.leaf_count,
            verified_onchain: false,
        };
        // ---- on-chain recompute (TEE then trusted only for confidentiality + liveness)
        let recompute = n <= self.cfg.recompute_cap;
        if recompute {
            let entries = self.entries_with(&plains);
            let r = match sc::clear(&self.sc_params(), &entries) {
                Ok(r) => r,
                Err(_) => return self.reject("recompute error"),
            };
            if !matches_result(&claimed, &r) {
                return self.reject("TEE output does not match on-chain recompute");
            }
        } else {
            // sanity only; correctness comes from the challenge window
            if claimed.sold.checked_add(claimed.burned) != Some(self.cfg.auction_supply.0) {
                return self.reject("sold + burned != supply");
            }
        }
        for (i, p) in plains.into_iter().enumerate() {
            if let Some(p) = p {
                self.plains.insert(i as u32, p);
            }
        }
        let mut cs = claimed;
        cs.verified_onchain = recompute;
        self.clearing = Some(cs);
        if recompute {
            self.status = Status::Cleared;
            self.cleared_at = now();
        } else {
            self.status = Status::Challenge;
            self.challenge_end = now() + self.cfg.challenge_secs as u64 * NS;
        }
        log!(
            "EVENT_JSON:{{\"event\":\"cleared\",\"verified_onchain\":{},\"p_star\":\"{}\",\"slots\":{}}}",
            recompute, out.p_star.0, n
        );
        log!("on_clear_used_gas={}", env::used_gas().as_gas());
        true
    }

    // ============================================================== challenge

    /// Challenge window only. Proves the TEE falsely dropped / altered a valid bid -> sale voided (Refund mode).
    pub fn challenge(&mut self, idx: u32, price: U128, size: U128, salt: String) {
        self.require_challenge_window();
        let s = self.slot(idx);
        require!(!s.cancelled && s.commit != [0; 32], "empty slot");
        let bid = sc::Bid { price: price.0, size: size.0, salt: must_unhex32(&salt, "salt") };
        require!(
            sc::commit_hash(&bid, s.bidder.as_str(), env::current_account_id().as_str()) == s.commit,
            "plaintext does not match stored commit"
        );
        require!(
            bid.price != 0
                && bid.size != 0
                && bid.size >= self.cfg.min_size.0
                && bid.size <= sc::MAX_BID_SIZE
                && bid.price >= self.cfg.reserve_price.0,
            "bid is not valid under the rules"
        );
        match sc::cost(bid.price, bid.size, self.cfg.token_decimals) {
            Some(c) if c <= s.deposit => {}
            _ => env::panic_str("bid is underfunded"),
        }
        let stored = self.plains.get(&idx).cloned();
        require!(
            stored != Some(PlainBid { price: bid.price, size: bid.size, salt: bid.salt }),
            "no fault: the TEE published this bid correctly"
        );
        self.void("valid bid dropped/altered by TEE");
    }

    /// Challenge window only, anyone: recompute from the published plaintexts on-chain (any slot count,
    /// costs whatever gas it needs). Voids the sale iff the posted clearing differs. Returns true iff voided.
    pub fn challenge_recompute(&mut self) -> bool {
        self.require_challenge_window();
        let plains: Vec<Option<PlainBid>> = (0..self.slots.len()).map(|i| self.plains.get(&i).cloned()).collect();
        let entries = self.entries_with(&plains);
        let r = sc::clear(&self.sc_params(), &entries);
        let ok = match (&r, &self.clearing) {
            (Ok(r), Some(c)) => matches_result(c, r),
            _ => false,
        };
        if !ok {
            self.void("posted clearing != recomputation");
            return true;
        }
        false
    }

    // ============================================================== claim / refund

    /// After Cleared. Anyone may submit for `bidder` (funds go to the bidder). Once per bidder.
    pub fn claim(&mut self, bidder: AccountId, index: u32, tokens: U128, refund: U128, proof: Vec<String>) -> PromiseOrValue<bool> {
        self.advance();
        require!(matches!(self.status, Status::Cleared | Status::Settled), format!("not claimable (status {:?})", self.status));
        require!(!self.claimed.contains(&bidder), "already claimed");
        let c = self.clearing.as_ref().unwrap();
        let leaf = sc::Leaf { bidder: bidder.to_string(), tokens: tokens.0, refund: refund.0 };
        let hs: Vec<[u8; 32]> = proof.iter().map(|p| must_unhex32(p, "proof")).collect();
        require!(
            sc::verify_proof(&c.alloc_root, &sc::leaf_hash(&leaf), index as u64, c.leaf_count as u64, &hs),
            "invalid merkle proof"
        );
        self.claimed.insert(bidder.clone());
        if tokens.0 > 0 {
            self.send_tokens(&bidder, tokens.0);
        }
        log!("EVENT_JSON:{{\"event\":\"claim\",\"bidder\":\"{}\",\"tokens\":\"{}\",\"refund\":\"{}\"}}", bidder, tokens.0, refund.0);
        if refund.0 > 0 {
            self.escrow -= refund.0;
            return PromiseOrValue::Promise(self.pay_out(bidder, refund.0));
        }
        PromiseOrValue::Value(true)
    }

    pub fn is_refund_mode(&self) -> bool {
        self.status == Status::Refund
            || (matches!(self.status, Status::Bidding | Status::Clearing) && now() >= self.deadline_ns())
    }

    /// Refund mode only (void or timeout): slot deposit (+ bond) in full, once. The bid fee is not returned.
    pub fn refund(&mut self, idx: u32) -> PromiseOrValue<bool> {
        require!(self.is_refund_mode(), "not in refund mode");
        self.status = Status::Refund;
        match self.refund_slot(idx) {
            Some(p) => PromiseOrValue::Promise(p),
            None => env::panic_str("nothing to refund"),
        }
    }

    /// Liveness helper: refund slots [from, from+limit). Skips already-refunded/empty slots. Returns #paid.
    pub fn refund_all(&mut self, from: u32, limit: u32) -> u32 {
        require!(self.is_refund_mode(), "not in refund mode");
        self.status = Status::Refund;
        let end = (from.saturating_add(limit.min(25))).min(self.slots.len());
        let mut n = 0;
        for i in from..end {
            if self.refund_slot(i).is_some() {
                n += 1;
            }
        }
        n
    }

    /// Re-send a payout that failed (e.g. recipient not storage-registered on the payment token).
    pub fn retry_payout(&mut self, account_id: AccountId) -> Promise {
        let amt = self.failed_payouts.get(&account_id).copied().unwrap_or(0);
        require!(amt > 0, "nothing pending");
        self.failed_payouts.remove(&account_id);
        self.failed_total -= amt;
        self.pay_out(account_id, amt)
    }

    // ============================================================== settle / vesting / fees

    /// Anyone, after Cleared: LP at P* (if configured), burn unsold + unused LP reserve, pay creator.
    pub fn settle(&mut self) -> PromiseOrValue<bool> {
        self.advance();
        require!(self.status == Status::Cleared, format!("settle needs status Cleared (is {:?})", self.status));
        let c = self.clearing.clone().unwrap();
        self.status = Status::Settled;
        let reserve = self.cfg.lp_token_reserve.0;
        let mut lp_funds = 0u128;
        let mut lp_tokens = 0u128;
        if self.cfg.lp_bps > 0 && self.cfg.ref_exchange.is_some() && c.raise > 0 {
            lp_funds = sc::mul_div(c.raise, self.cfg.lp_bps as u128, 10_000).map(|x| x.0).unwrap_or(0);
            // size both sides so pool price == p_star: tokens from funds, then funds from tokens.
            // If the reserve is too small, shrink funds (the rest goes to the creator) instead of mispricing.
            let d = sc::pow10(self.cfg.token_decimals);
            lp_tokens = sc::mul_div(lp_funds, d, c.p_star).map(|x| x.0).unwrap_or(0).min(reserve);
            lp_funds = sc::mul_div(lp_tokens, c.p_star, d).map(|x| x.0).unwrap_or(0).min(lp_funds);
            if lp_tokens == 0 || lp_funds == 0 {
                lp_tokens = 0;
                lp_funds = 0;
            }
        }
        self.burn_self(c.burned + (reserve - lp_tokens));
        let creator_funds = c.raise - lp_funds;
        self.escrow -= c.raise;
        let mut promise: Option<Promise> = None;
        if lp_tokens > 0 {
            self.lp_status = LpStatus::Pending;
            promise = Some(self.start_lp(lp_funds, lp_tokens));
        }
        if creator_funds > 0 {
            let p = self.pay_out(self.cfg.creator.clone(), creator_funds);
            // (joint promises can't be returned; the LP chain, if any, runs independently and reports via lp_status)
            promise = Some(p);
        }
        log!(
            "EVENT_JSON:{{\"event\":\"settled\",\"lp_funds\":\"{lp_funds}\",\"lp_tokens\":\"{lp_tokens}\",\"creator_funds\":\"{creator_funds}\"}}"
        );
        match promise {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(true),
        }
    }

    /// Creator vesting (linear from Cleared). Anyone may trigger; tokens go to the creator.
    pub fn claim_vested(&mut self) -> U128 {
        self.advance();
        require!(matches!(self.status, Status::Cleared | Status::Settled), "not cleared");
        let total = self.cfg.creator_supply.0;
        let elapsed = now().saturating_sub(self.cleared_at) as u128;
        let span = self.cfg.vesting_secs as u128 * NS as u128;
        let vested = if span == 0 || elapsed >= span { total } else { sc::mul_div(total, elapsed, span).unwrap().0 };
        let due = vested - self.vested_paid;
        require!(due > 0, "nothing vested");
        self.vested_paid += due;
        let creator = self.cfg.creator.clone();
        self.send_tokens(&creator, due);
        U128(due)
    }

    /// After Settled or in Refund mode: pay accrued bid fees (and slashed bonds) to the creator, never
    /// touching bidder escrow or storage reserve.
    pub fn withdraw_fees(&mut self) -> PromiseOrValue<U128> {
        require!(matches!(self.status, Status::Settled | Status::Refund), "after settle or in refund mode");
        let pending = self.fees_accrued - self.fees_withdrawn;
        let mut amt = pending;
        if self.cfg.payment_token.is_none() {
            let reserve = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128
                + NearToken::from_millinear(100).as_yoctonear();
            let free = env::account_balance()
                .as_yoctonear()
                .saturating_sub(reserve)
                .saturating_sub(self.escrow)
                .saturating_sub(self.failed_total);
            amt = amt.min(free);
        }
        require!(amt > 0, "no withdrawable fees");
        self.fees_withdrawn += amt;
        let p = self.pay_out(self.cfg.creator.clone(), amt);
        PromiseOrValue::Promise(p.then(Self::ext(env::current_account_id()).ret(U128(amt))))
    }

    #[private]
    pub fn ret(&self, v: U128) -> U128 {
        v
    }

    // ============================================================== fallback: commit-reveal (no TEE)

    /// attached = fee + reveal_bond + deposit.
    #[payable]
    pub fn bid_commit(&mut self, commit: String) -> u32 {
        require!(self.mode() == Mode::Fallback, "TEE mode: use bid()");
        let bond = self.cfg.reveal_bond.0;
        self.place(env::predecessor_account_id(), env::attached_deposit().as_yoctonear(), None, commit, None, bond)
    }

    /// Reveal window only. Checks sha256 == commit; bond returned.
    pub fn reveal(&mut self, idx: u32, price: U128, size: U128, salt: String) -> PromiseOrValue<bool> {
        require!(self.mode() == Mode::Fallback, "TEE mode");
        let t = now();
        require!(t >= self.bid_end_ns() && t < self.reveal_end_ns(), "not in reveal window");
        require!(self.status == Status::Bidding, "bad status");
        let mut s = self.slot(idx);
        require!(env::predecessor_account_id() == s.bidder, "only the bidder");
        require!(!s.revealed && !s.cancelled, "already revealed / cancelled");
        let bid = sc::Bid { price: price.0, size: size.0, salt: must_unhex32(&salt, "salt") };
        require!(
            sc::commit_hash(&bid, s.bidder.as_str(), env::current_account_id().as_str()) == s.commit,
            "reveal does not match commit"
        );
        self.plains.insert(idx, PlainBid { price: bid.price, size: bid.size, salt: bid.salt });
        s.revealed = true;
        let bond = s.bond;
        s.bond = 0;
        let to = s.bidder.clone();
        self.escrow -= bond;
        self.slots.replace(idx, s);
        if bond == 0 {
            return PromiseOrValue::Value(true);
        }
        PromiseOrValue::Promise(self.pay_out(to, bond))
    }

    /// After reveal_end: run the identical `clear` on-chain on the revealed bids. No challenge window.
    pub fn clear(&mut self) {
        require!(self.mode() == Mode::Fallback, "TEE mode: use finalize()");
        let t = now();
        require!(t >= self.reveal_end_ns(), "reveal window open");
        require!(t < self.deadline_ns(), "clear window passed: refund mode");
        require!(self.status == Status::Bidding, "already cleared");
        let plains: Vec<Option<PlainBid>> = (0..self.slots.len()).map(|i| self.plains.get(&i).cloned()).collect();
        let entries = self.entries_with(&plains);
        let r = sc::clear(&self.sc_params(), &entries).unwrap_or_else(|_| env::panic_str("clear failed"));
        self.accept_clearing(&r, true);
        log!("clear_used_gas={}", env::used_gas().as_gas());
    }

    /// After reveal_end: forfeit the bond of an unrevealed slot (-> accrued fees/treasury). Deposit stays claimable.
    pub fn slash_unrevealed(&mut self, idx: u32) {
        require!(self.mode() == Mode::Fallback, "TEE mode");
        require!(now() >= self.reveal_end_ns(), "reveal window open");
        let mut s = self.slot(idx);
        require!(!s.revealed && !s.cancelled && s.bond > 0, "nothing to slash");
        let bond = s.bond;
        s.bond = 0;
        self.slots.replace(idx, s);
        self.escrow -= bond;
        self.fees_accrued += bond;
    }

    // ============================================================== views

    pub fn get_sale(&self) -> SaleInfo {
        SaleInfo {
            status: self.status,
            refund_mode: self.is_refund_mode(),
            mode: self.mode(),
            params: self.cfg.clone(),
            bid_count: self.slots.len(),
            deposits_total: U128(self.deposits_total),
            fees_accrued: U128(self.fees_accrued),
            in_flight: self.in_flight,
            challenge_end_ns: U64(self.challenge_end),
            cleared_at_ns: U64(self.cleared_at),
            lp_status: self.lp_status,
            creator_vested: U128(self.vested_paid),
            voided: self.voided,
        }
    }
    pub fn get_bid_count(&self) -> u32 {
        self.slots.len()
    }
    pub fn get_deposits_total(&self) -> U128 {
        U128(self.deposits_total)
    }
    pub fn get_bid(&self, idx: u32) -> BidSlotView {
        let s = self.slot(idx);
        BidSlotView {
            bidder: s.bidder,
            commit: hx(&s.commit),
            ciphertext: hx(self.ciphertexts.get(&idx).map(|v| v.as_slice()).unwrap_or(&[])),
            deposit: U128(s.deposit),
            ts: U64(s.ts),
        }
    }
    pub fn get_clearing(&self) -> Option<ClearingSummary> {
        self.clearing.as_ref().map(|c| ClearingSummary {
            p_star: U128(c.p_star),
            sold: U128(c.sold),
            burned: U128(c.burned),
            raise: U128(c.raise),
            alloc_root: hx(&c.alloc_root),
            leaf_count: c.leaf_count,
            input_hash: hx(&c.input_hash),
            status: self.status,
            verified_onchain: c.verified_onchain,
        })
    }
    pub fn get_revealed_bids(&self, from: u32, limit: u32) -> Vec<Option<RevealedBid>> {
        let end = from.saturating_add(limit).min(self.slots.len());
        (from..end)
            .map(|i| {
                self.plains.get(&i).map(|p| RevealedBid { price: U128(p.price), size: U128(p.size), salt: hx(&p.salt), ts: U64(self.slot(i).ts) })
            })
            .collect()
    }
    pub fn get_pubkey(&self) -> Option<String> {
        self.pubkey.as_ref().map(|p| hx(p))
    }
    pub fn is_claimed(&self, account_id: AccountId) -> bool {
        self.claimed.contains(&account_id)
    }
    pub fn get_failed_payout(&self, account_id: AccountId) -> U128 {
        U128(self.failed_payouts.get(&account_id).copied().unwrap_or(0))
    }
    /// Minimum prepaid gas a `finalize` call needs for the current bid set (payload-sized).
    pub fn finalize_gas_needed(&self) -> U64 {
        let n = self.slots.len() as usize;
        // payload ~= 2*(ciphertext) + bidder + commit... estimate from stored data size
        let approx_len = 600 + n * 520;
        U64(callback_gas(n, n as u32 <= self.cfg.recompute_cap).as_gas()
            + buffer_gas(approx_len).as_gas()
            + Gas::from_tgas(10).as_gas()
            + n as u64 * 350_000_000_000 // finalize receipt itself: measured ~0.32 Tgas/slot building input_data
            + Gas::from_tgas(30).as_gas())
    }
    /// NEAR to attach to `finalize`. With no argument: exact, from the stored bid set (the set is
    /// frozen after bid_end, so this is what `finalize` will check). With `bid_count`: a planning
    /// estimate assuming `EST_ENTRY_BYTES` per bid. `required` is what `finalize` enforces;
    /// `recommended` = required + 25% (headroom capped at 1 NEAR). Unused NEAR is refunded to the caller.
    pub fn get_finalize_deposit(&self, bid_count: Option<u32>) -> FinalizeDeposit {
        let (n, len, exact) = match bid_count {
            Some(n) => (n, estimate_input_len(n), false),
            None => (self.slots.len(), if self.slots.is_empty() { 0 } else { self.clear_input().len() }, true),
        };
        let required = if n == 0 { 0 } else { outlayer_required_deposit(len, n) };
        FinalizeDeposit {
            bid_count: n,
            input_len: len as u64,
            exact,
            required: U128(required),
            recommended: U128(recommended_deposit(required)),
        }
    }
}

// ================================================================== internals

impl Sale {
    /// The OutLayer `input_data` string, built only from contract state.
    fn clear_input(&self) -> String {
        let n = self.slots.len();
        let entries: Vec<_> = (0..n)
            .map(|i| {
                let s = self.slots.get(i).unwrap();
                near_sdk::serde_json::json!({
                    "bidder": s.bidder,
                    "commit": hx(&s.commit),
                    "deposit": s.deposit.to_string(),
                    "ciphertext": hx(self.ciphertexts.get(&i).map(|v| v.as_slice()).unwrap_or(&[])),
                })
            })
            .collect();
        near_sdk::serde_json::json!({
            "action": "clear",
            "params": {
                "sale_id": env::current_account_id(),
                "supply": self.cfg.auction_supply.0.to_string(),
                "reserve": self.cfg.reserve_price.0.to_string(),
                "token_decimals": self.cfg.token_decimals,
                "min_size": self.cfg.min_size.0.to_string(),
                "code_hash": self.cfg.code_hash,
                "bid_end_ms": self.cfg.bid_end_ms.0,
            },
            "entries": entries,
        })
        .to_string()
    }
    fn mode(&self) -> Mode {
        self.cfg.mode.unwrap_or(Mode::Tee)
    }
    fn bid_end_ns(&self) -> u64 {
        self.cfg.bid_end_ms.0 * 1_000_000
    }
    fn reveal_end_ns(&self) -> u64 {
        self.bid_end_ns() + self.cfg.reveal_secs * NS
    }
    fn deadline_ns(&self) -> u64 {
        let base = if self.mode() == Mode::Fallback { self.reveal_end_ns() } else { self.bid_end_ns() };
        base + self.cfg.finalize_timeout_secs * NS
    }
    fn slot(&self, idx: u32) -> Slot {
        self.slots.get(idx).unwrap_or_else(|| env::panic_str("no such bid")).clone()
    }
    fn sc_params(&self) -> sc::Params {
        sc::Params {
            sale_id: env::current_account_id().to_string(),
            supply: self.cfg.auction_supply.0,
            reserve: self.cfg.reserve_price.0,
            token_decimals: self.cfg.token_decimals,
            min_size: self.cfg.min_size.0,
        }
    }
    fn dest_of(s: &Slot) -> AccountId {
        s.refund_to.as_ref().and_then(|r| r.parse::<AccountId>().ok()).unwrap_or_else(|| s.bidder.clone())
    }
    fn require_bidding_open(&self) {
        require!(self.status == Status::Bidding && now() < self.bid_end_ns(), "bidding is closed");
    }
    fn require_challenge_window(&self) {
        require!(self.status == Status::Challenge, "not in challenge window");
        require!(now() < self.challenge_end, "challenge window over");
    }

    /// Lazy Challenge -> Cleared once the window has elapsed with no void.
    fn advance(&mut self) {
        if self.status == Status::Challenge && now() >= self.challenge_end {
            self.status = Status::Cleared;
            self.cleared_at = self.challenge_end;
        }
    }

    fn void(&mut self, why: &str) {
        self.status = Status::Refund;
        self.voided = true;
        log!("EVENT_JSON:{{\"event\":\"voided\",\"why\":\"{why}\"}}");
    }

    fn reject(&mut self, why: &str) -> bool {
        log!("EVENT_JSON:{{\"event\":\"on_clear_rejected\",\"why\":\"{why}\"}}");
        false
    }

    fn place_sealed(&mut self, bidder: AccountId, amount: u128, ct: String, commit: String, refund_to: Option<String>) -> u32 {
        require!(self.mode() == Mode::Tee, "fallback mode: use bid_commit()");
        let ct = unhex(&ct).unwrap_or_else(|| env::panic_str("ciphertext: bad hex"));
        require!(!ct.is_empty() && ct.len() <= MAX_CT_BYTES, "ciphertext size");
        self.place(bidder, amount, Some(ct), commit, refund_to, 0)
    }

    fn place(&mut self, bidder: AccountId, amount: u128, ct: Option<Vec<u8>>, commit: String, refund_to: Option<String>, bond: u128) -> u32 {
        self.require_bidding_open();
        require!((self.slots.len()) < self.cfg.max_bids, "max_bids reached");
        let commit = must_unhex32(&commit, "commit");
        require!(commit != [0; 32], "zero commit");
        require!(self.commit_idx.get(&commit).is_none(), "duplicate commit");
        if let Some(r) = &refund_to {
            require!(r.len() <= 128, "refund_to too long");
        }
        let fee = self.cfg.bid_fee.0;
        require!(amount > fee + bond, "attached must exceed fee + bond (deposit > 0)");
        let deposit = amount - fee - bond;
        self.fees_accrued += fee;
        self.deposits_total += deposit;
        self.escrow += deposit + bond;
        let idx = self.slots.len();
        self.commit_idx.insert(commit, idx);
        self.slots.push(Slot { bidder, commit, deposit, bond, refund_to, refunded: false, cancelled: false, revealed: false, ts: env::block_timestamp_ms() });
        if let Some(ct) = ct {
            self.ciphertexts.insert(idx, ct);
        }
        log!("EVENT_JSON:{{\"event\":\"bid\",\"idx\":{idx}}}");
        idx
    }

    /// Non-panicking FT bid validation + placement. Err = reason string (transfer becomes Unclaimed).
    fn try_ft_bid(&mut self, sender: &AccountId, amount: u128, m: FtBidMsg) -> Result<u32, String> {
        if m.v.unwrap_or(1) != 1 {
            return Err("unsupported msg version".into());
        }
        if m.sale_id != env::current_account_id().as_str() {
            return Err("sale_id mismatch".into());
        }
        if self.mode() != Mode::Tee {
            return Err("fallback mode takes NEAR only".into());
        }
        if !(self.status == Status::Bidding && now() < self.bid_end_ns()) {
            return Err("bidding closed".into());
        }
        if self.slots.len() >= self.cfg.max_bids {
            return Err("max_bids reached".into());
        }
        let ct = unhex(&m.ciphertext).filter(|c| !c.is_empty() && c.len() <= MAX_CT_BYTES).ok_or("bad ciphertext")?;
        let commit = unhex32(&m.commit).filter(|c| *c != [0; 32]).ok_or("bad commit")?;
        if self.commit_idx.get(&commit).is_some() {
            return Err("duplicate commit".into());
        }
        let bidder: AccountId = match &m.bidder {
            Some(b) => b.parse().map_err(|_| "bidder is not a NEAR account".to_string())?,
            None => sender.clone(),
        };
        if let Some(r) = &m.refund_to {
            if r.len() > 128 {
                return Err("refund_to too long".into());
            }
        }
        let fee = self.cfg.bid_fee.0;
        if amount <= fee {
            return Err("amount does not exceed fee".into());
        }
        let deposit = amount - fee;
        self.fees_accrued += fee;
        self.deposits_total += deposit;
        self.escrow += deposit;
        let idx = self.slots.len();
        self.commit_idx.insert(commit, idx);
        self.slots.push(Slot { bidder, commit, deposit, bond: 0, refund_to: m.refund_to, refunded: false, cancelled: false, revealed: false, ts: env::block_timestamp_ms() });
        self.ciphertexts.insert(idx, ct);
        Ok(idx)
    }

    fn add_deposit(&mut self, idx: u32, who: &AccountId, amount: u128) {
        self.require_bidding_open();
        require!(amount > 0, "zero top-up");
        let mut s = self.slot(idx);
        require!(&s.bidder == who, "only the bidder may top up");
        require!(!s.cancelled, "cancelled slot");
        s.deposit += amount;
        self.deposits_total += amount;
        self.escrow += amount;
        self.slots.replace(idx, s);
    }

    /// entries in slot order; `plains[i]` supplies plaintexts (all None for hashing).
    fn entries_with(&self, plains: &[Option<PlainBid>]) -> Vec<sc::BidEntry> {
        (0..self.slots.len())
            .map(|i| {
                let s = self.slots.get(i).unwrap();
                sc::BidEntry {
                    bidder: s.bidder.to_string(),
                    commit: s.commit,
                    deposit: s.deposit,
                    plaintext: plains
                        .get(i as usize)
                        .and_then(|p| p.as_ref())
                        .map(|p| sc::Bid { price: p.price, size: p.size, salt: p.salt }),
                }
            })
            .collect()
    }

    fn accept_clearing(&mut self, r: &sc::ClearingResult, verified: bool) {
        self.clearing = Some(ClearingState {
            p_star: r.p_star,
            sold: r.sold,
            burned: r.burned,
            raise: r.raise,
            alloc_root: r.alloc_root,
            input_hash: r.input_hash,
            leaf_count: r.leaves.len() as u32,
            verified_onchain: verified,
        });
        self.status = Status::Cleared;
        self.cleared_at = now();
        self.in_flight = false;
    }

    fn refund_slot(&mut self, idx: u32) -> Option<Promise> {
        let mut s = self.slots.get(idx)?.clone();
        let amt = s.deposit + s.bond;
        if s.refunded || amt == 0 {
            return None;
        }
        s.refunded = true;
        self.escrow -= amt;
        let dest = Self::dest_of(&s);
        self.slots.replace(idx, s);
        Some(self.pay_out(dest, amt))
    }

    fn send_tokens(&mut self, to: &AccountId, amount: u128) {
        let me = env::current_account_id();
        if self.token.accounts.get(to).is_none() {
            self.token.internal_register_account(to);
        }
        self.token.internal_transfer(&me, to, amount, None);
    }

    fn burn_self(&mut self, amount: u128) {
        if amount == 0 {
            return;
        }
        let me = env::current_account_id();
        self.token.internal_withdraw(&me, amount); // also reduces total_supply
        FtBurn { owner_id: &me, amount: U128(amount), memo: Some("sale burn") }.emit();
    }

    /// Pay `amount` of the payment token to `to`; failures are credited to `failed_payouts` (retry_payout).
    fn pay_out(&self, to: AccountId, amount: u128) -> Promise {
        let p = match &self.cfg.payment_token {
            None => Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)),
            Some(t) => ext_ft::ext(t.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(FT_TRANSFER_GAS)
                .ft_transfer(to.clone(), U128(amount), None),
        };
        p.then(Self::ext(env::current_account_id()).with_static_gas(PAYOUT_CB_GAS).on_payout(to, U128(amount)))
    }
}

#[near]
impl Sale {
    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128) -> bool {
        match env::promise_result_checked(0, 16) {
            Ok(_) => true,
            Err(_) => {
                let cur = self.failed_payouts.get(&to).copied().unwrap_or(0);
                self.failed_payouts.insert(to.clone(), cur + amount.0);
                self.failed_total += amount.0;
                log!("EVENT_JSON:{{\"event\":\"payout_failed\",\"to\":\"{}\",\"amount\":\"{}\"}}", to, amount.0);
                false
            }
        }
    }
}

fn msg_key(sender: &AccountId, token: &AccountId, msg: &str) -> [u8; 32] {
    let mut b = Vec::new();
    for s in [sender.as_str(), token.as_str(), msg] {
        b.extend_from_slice(&(s.len() as u32).to_be_bytes());
        b.extend_from_slice(s.as_bytes());
    }
    env::sha256_array(&b)
}

fn parse_ft_msg(msg: &str) -> Option<FtBidMsg> {
    if msg.len() > 1024 {
        return None;
    }
    let t = msg.trim();
    if t.starts_with('{') {
        return near_sdk::serde_json::from_str(t).ok();
    }
    let raw = b64url_decode(t)?;
    near_sdk::serde_json::from_slice(&raw).ok()
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.trim_end_matches('=').bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn matches_result(c: &ClearingState, r: &sc::ClearingResult) -> bool {
    c.p_star == r.p_star
        && c.sold == r.sold
        && c.burned == r.burned
        && c.raise == r.raise
        && c.alloc_root == r.alloc_root
        && c.leaf_count as usize == r.leaves.len()
        && c.input_hash == r.input_hash
}

/// ~2e9 per 100 bids + 3e9 headroom (spike: ~6.3M instructions per bid; default 1e9 fails at 200).
fn max_instructions(n: u32) -> u64 {
    3_000_000_000 + 2_000_000_000 * (n as u64).div_ceil(100)
}

// --- OutLayer deposit. Mirrors outlayer.testnet `request_execution` admission (source:
// `estimate_cost` + `input_storage_deposit`; live `get_pricing_full` and `estimate_execution_cost`
// checked 2026-11-11): base_fee + max_instructions/1e6 * per_million_instructions_fee
// + max_execution_seconds*1000 * per_ms_fee + (input_len - 32 KiB)^+ * 1e-5 NEAR (refundable hold).
// If OutLayer raises prices, callers can attach more (this is only a floor); everything above the
// actual charge is refunded by OutLayer to `payer_account_id` (the finalize caller).
const MAX_EXECUTION_SECONDS: u64 = 60;
const OL_BASE_FEE: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const OL_PER_MILLION_INSTRUCTIONS_FEE: u128 = 100_000_000_000_000; // 1e-10 NEAR
const OL_PER_MS_FEE: u128 = 100_000_000_000_000_000; // 1e-7 NEAR
const OL_INPUT_FREE_BYTES: usize = 32 * 1024;
const OL_STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000; // 1e-5 NEAR
/// Planning estimate of one `entries` item (live 100-bid sale: 49,521 B input -> ~490 B/bid;
/// spike: 487 B/bid). Only used by `get_finalize_deposit(Some(n))`; finalize uses the real length.
const EST_ENTRY_BYTES: usize = 500;
const EST_INPUT_OVERHEAD_BYTES: usize = 600;
const DEPOSIT_HEADROOM_CAP: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR

/// Minimum NEAR OutLayer accepts for a run over `n` bids with `input_len` bytes of `input_data`.
fn outlayer_required_deposit(input_len: usize, n: u32) -> u128 {
    let compute = OL_BASE_FEE
        + (max_instructions(n) / 1_000_000) as u128 * OL_PER_MILLION_INSTRUCTIONS_FEE
        + (MAX_EXECUTION_SECONDS * 1000) as u128 * OL_PER_MS_FEE;
    compute + input_len.saturating_sub(OL_INPUT_FREE_BYTES) as u128 * OL_STORAGE_PRICE_PER_BYTE
}
/// required + 25% headroom (capped at +1 NEAR), rounded up to 0.001 NEAR.
fn recommended_deposit(required: u128) -> u128 {
    if required == 0 {
        return 0;
    }
    let milli = 1_000_000_000_000_000_000_000u128;
    let r = required + (required / 4).min(DEPOSIT_HEADROOM_CAP);
    r.div_ceil(milli) * milli
}
fn estimate_input_len(n: u32) -> usize {
    EST_INPUT_OVERHEAD_BYTES + n as usize * EST_ENTRY_BYTES
}

/// Gas reserved for the `on_clear` callback.
fn callback_gas(n: usize, recompute: bool) -> Gas {
    let per = if recompute { CB_PER_BID_RECOMPUTE_GGAS } else { CB_PER_BID_STORE_GGAS };
    Gas::from_gas(CB_BASE_TGAS * 1_000_000_000_000 + n as u64 * per * 1_000_000_000)
}
// set from the benchmark in NOTES.md (with margin)
const CB_BASE_TGAS: u64 = 20;
const CB_PER_BID_RECOMPUTE_GGAS: u64 = 450; // measured 0.37 Tgas/bid + 2 base (N=50..200)
const CB_PER_BID_STORE_GGAS: u64 = 300; // measured 0.22 Tgas/bid (store plaintexts, no recompute)

/// Buffer withheld from the outgoing `request_execution` receipt: the receipt is metered by payload
/// size (spike: 70 Tgas buffer worked at 97 KB, 10 Tgas failed).
fn buffer_gas(payload_len: usize) -> Gas {
    Gas::from_gas(20_000_000_000_000 + payload_len as u64 * 600_000)
}

// --- NEP-141 token surface (the sale account is the token)
impl_fungible_token_core!(Sale, token);

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
#[near]
impl StorageManagement for Sale {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Sale {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[allow(dead_code)]
fn _unused(_: ()) {
    assert_one_yocto();
}

#[cfg(test)]
mod deposit_tests {
    use super::*;
    const MILLI: u128 = 1_000_000_000_000_000_000_000;

    #[test]
    fn finalize_deposit_matches_outlayer_formula_and_grows_with_bids() {
        // spike-outlayer/RESULTS.md (c): input_data bytes for 10/100/200 bids. Expected =
        // 0.001 base + max_instr/1e6 * 1e-10 + 60_000 ms * 1e-7 + (len - 32768)^+ * 1e-5 NEAR.
        // max_instructions: 10 -> 5e9, 100 -> 5e9, 200 -> 7e9.
        let cases: [(u32, usize, u128); 3] = [
            (10, 4_904, 7_000_500_000_000_000_000_000),                           // 0.0070005 (no hold)
            (100, 48_734, 7_000_500_000_000_000_000_000 + 15_966 * 10_000_000_000_000_000_000), // 0.1666605
            (200, 97_734, 7_000_700_000_000_000_000_000 + 64_966 * 10_000_000_000_000_000_000), // 0.6566607
        ];
        for (n, len, want) in cases {
            assert_eq!(outlayer_required_deposit(len, n), want, "n={n}");
        }
        // Live failure (n100 sale): OutLayer asked 0.1745 NEAR for a 49,521-byte input; flat 0.1 was < that.
        let live = outlayer_required_deposit(49_521, 100);
        assert_eq!(live, 7_000_500_000_000_000_000_000 + (49_521 - 32_768) as u128 * 10_000_000_000_000_000_000);
        assert!(live > 100 * MILLI && live / MILLI == 174);
        // Matches live outlayer.testnet estimate_execution_cost(limits{5e9,60s}, 82_289) = 502210500000000000000000.
        assert_eq!(outlayer_required_deposit(82_289, 100), 502_210_500_000_000_000_000_000);

        // Monotonic in bid count (estimate path) and strictly growing once over the free 32 KiB.
        let mut prev = 0;
        for n in [1u32, 10, 50, 64, 65, 100, 200, 500, 1000] {
            let d = outlayer_required_deposit(estimate_input_len(n), n);
            assert!(d >= prev, "n={n}");
            if estimate_input_len(n) > OL_INPUT_FREE_BYTES {
                assert!(d > prev);
            }
            prev = d;
        }
        // Recommended: +25%, rounded up to 0.001 NEAR, headroom capped at 1 NEAR.
        assert_eq!(recommended_deposit(0), 0);
        assert_eq!(recommended_deposit(live), 219 * MILLI); // 0.17453 * 1.25 = 0.21816 -> 0.219
        let big = 10_000 * MILLI;
        assert_eq!(recommended_deposit(big), big + 1000 * MILLI);
        for (n, len, _) in cases {
            let r = outlayer_required_deposit(len, n);
            assert!(recommended_deposit(r) >= r + r / 5 && recommended_deposit(r) <= r + r * 3 / 10 + MILLI);
        }
    }
}
