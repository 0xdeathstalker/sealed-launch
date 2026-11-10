use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(serializers=[json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Bidding,
    Clearing,
    Challenge,
    Cleared,
    Settled,
    Refund,
}

#[near(serializers=[json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Sealed bids, TEE clearing (default).
    Tee,
    /// Commit-reveal, no TEE: contract runs the same `clear` on revealed bids.
    Fallback,
}

/// Immutable sale rules, written once at `init` (the factory passes CreateParams + wiring).
#[near(serializers=[json, borsh])]
#[derive(Clone, Debug)]
pub struct InitParams {
    // --- SPEC §6 CreateParams (minus `name`, which is the account label)
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
    // --- wiring supplied by the factory
    pub creator: AccountId,
    pub factory: AccountId,
    pub outlayer: AccountId,
    /// `T_finalize`: seconds after bid_end (fallback: after reveal_end) without a cleared result -> Refund mode.
    pub finalize_timeout_secs: u64,
    /// On-chain recompute is done in `on_clear` iff slots <= this (<= RECOMPUTE_CAP_MAX).
    pub recompute_cap: u32,
    pub mode: Option<Mode>,
    pub reveal_secs: u64,
    pub reveal_bond: U128,
    pub pubkey: Option<String>,
    /// Ref Finance exchange + wNEAR (quote token when payment is native NEAR). None = no LP (stub).
    pub ref_exchange: Option<AccountId>,
    pub wnear: Option<AccountId>,
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
pub struct Slot {
    pub bidder: AccountId,
    pub commit: [u8; 32],
    pub deposit: u128,
    pub bond: u128,
    pub refund_to: Option<String>,
    pub refunded: bool,
    pub cancelled: bool,
    pub revealed: bool,
    /// block timestamp (ms) when the bid was placed
    pub ts: u64,
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlainBid {
    pub price: u128,
    pub size: u128,
    pub salt: [u8; 32],
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
pub struct ClearingState {
    pub p_star: u128,
    pub sold: u128,
    pub burned: u128,
    pub raise: u128,
    pub alloc_root: [u8; 32],
    pub input_hash: [u8; 32],
    pub leaf_count: u32,
    /// true if the contract itself recomputed and matched the TEE output (or ran `clear` in fallback).
    pub verified_onchain: bool,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LpStatus {
    None,
    Pending,
    Done,
    Failed,
}

// ------------------------------------------------------------------ JSON views / wire types

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct BidSlotView {
    pub bidder: AccountId,
    pub commit: String,
    pub ciphertext: String,
    pub deposit: U128,
    /// block timestamp in ms at bid time
    pub ts: U64,
}

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct RevealedBid {
    pub price: U128,
    pub size: U128,
    pub salt: String,
    /// block timestamp in ms at bid time of this slot
    pub ts: U64,
}

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct ClearingSummary {
    pub p_star: U128,
    pub sold: U128,
    pub burned: U128,
    pub raise: U128,
    pub alloc_root: String,
    pub leaf_count: u32,
    pub input_hash: String,
    pub status: Status,
    pub verified_onchain: bool,
}

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct SaleInfo {
    pub status: Status,
    pub refund_mode: bool,
    pub mode: Mode,
    pub params: InitParams,
    pub bid_count: u32,
    pub deposits_total: U128,
    pub fees_accrued: U128,
    pub in_flight: bool,
    pub challenge_end_ns: U64,
    pub cleared_at_ns: U64,
    pub lp_status: LpStatus,
    pub creator_vested: U128,
    pub voided: bool,
}

/// TEE output (SPEC §5). Extra fields are ignored.
#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct PlainJson {
    pub price: U128,
    pub size: U128,
    pub salt: String,
}

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct ClearOutput {
    pub sale_id: String,
    pub input_hash: String,
    pub code_hash: Option<String>,
    pub p_star: U128,
    pub sold: U128,
    pub burned: U128,
    pub raise: U128,
    pub alloc_root: String,
    pub leaf_count: u32,
    pub plaintexts: Vec<Option<PlainJson>>,
}

/// Intents / ft_transfer_call `msg` (unauthenticated). JSON text, or base64url(JSON). Max 1024 chars.
#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct FtBidMsg {
    pub v: Option<u32>,
    pub sale_id: String,
    pub ciphertext: String,
    pub commit: String,
    pub bidder: Option<String>,
    pub refund_to: Option<String>,
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
pub struct Unclaimed {
    pub sender: AccountId,
    pub token: AccountId,
    pub amount: u128,
    /// NEAR account parsed from msg (bidder, else refund_to) if any; refunds go there.
    pub refund_account: Option<AccountId>,
}

#[near(serializers=[json])]
#[derive(Clone, Debug)]
pub struct BidStatus {
    /// "accepted" | "unclaimed" | "unknown"
    pub state: String,
    pub idx: Option<u32>,
    pub reason: Option<String>,
}
