// Wire types for the sale + factory views (contracts/sale/src/types.rs, contracts/factory/src/lib.rs).
// u128/u64 arrive as decimal strings.

export type Status = "Bidding" | "Clearing" | "Challenge" | "Cleared" | "Settled" | "Refund";
export type LpStatus = "None" | "Pending" | "Done" | "Failed";

export interface SaleParamsWire {
  symbol: string;
  token_name: string;
  icon: string | null;
  token_decimals: number;
  auction_supply: string;
  lp_token_reserve: string;
  creator_supply: string;
  reserve_price: string;
  min_size: string;
  bid_fee: string;
  payment_token: string | null;
  bid_end_ms: string;
  challenge_secs: number;
  lp_bps: number;
  vesting_secs: number | string;
  outlayer_project: string;
  code_hash: string;
  max_bids: number;
  creator: string;
  factory: string;
  outlayer: string;
  finalize_timeout_secs: number | string;
  recompute_cap: number;
  mode: "Tee" | "Fallback" | null;
  reveal_secs: number | string;
  reveal_bond: string;
  pubkey: string | null;
  ref_exchange: string | null;
  wnear: string | null;
}

export interface SaleInfo {
  status: Status;
  refund_mode: boolean;
  mode: "Tee" | "Fallback";
  params: SaleParamsWire;
  bid_count: number;
  deposits_total: string;
  fees_accrued: string;
  in_flight: boolean;
  challenge_end_ns: string;
  cleared_at_ns: string;
  lp_status: LpStatus;
  creator_vested: string;
  voided: boolean;
}

export interface BidSlot { bidder: string; commit: string; ciphertext: string; deposit: string }
export interface RevealedBid { price: string; size: string; salt: string }
export interface ClearingSummary {
  p_star: string; sold: string; burned: string; raise: string;
  alloc_root: string; leaf_count: number; input_hash: string; status: Status; verified_onchain: boolean;
}
export interface BidStatus { state: "accepted" | "unclaimed" | "unknown" | string; idx: number | null; reason: string | null }

export interface FactorySaleRecord {
  account: string; creator: string; outlayer_project: string; status: "Creating" | "AwaitingPk" | "Ready"; pubkey: string | null;
}

export interface CreateParamsWire {
  name: string; symbol: string; token_name: string; icon: string | null; token_decimals: number;
  auction_supply: string; lp_token_reserve: string; creator_supply: string; reserve_price: string;
  min_size: string; bid_fee: string; payment_token: string | null; bid_end_ms: string; challenge_secs: number;
  lp_bps: number; vesting_secs: number; outlayer_project: string; code_hash: string; max_bids: number;
}

export interface TxCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}
export interface TxResult { txHash?: string; redirected?: boolean; note?: string }

export interface PayToken { symbol: string; decimals: number; account: string | null }
export interface KeyCheck { exists: boolean; keys: number | null; error?: string }
