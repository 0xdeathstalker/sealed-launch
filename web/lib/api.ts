import { MOCK } from "./config";
import type {
  BidSlot, BidStatus, ClearingSummary, FactorySaleRecord, KeyCheck, PayToken, RevealedBid, SaleInfo, TxCall,
} from "./types";
import { chainApi } from "./chain";
import { mockApi } from "./mock";
import type { FinalizeDeposit } from "./deposit";

export interface Api {
  /** Factory */
  requiredDeposit(): Promise<bigint>;
  listSales(): Promise<string[]>;
  factorySale(name: string): Promise<FactorySaleRecord | null>;
  /** Sale views */
  saleInfo(saleId: string): Promise<SaleInfo>;
  pubkey(saleId: string): Promise<string | null>;
  clearing(saleId: string): Promise<ClearingSummary | null>;
  bids(saleId: string, count: number): Promise<BidSlot[]>;
  revealed(saleId: string, count: number): Promise<(RevealedBid | null)[]>;
  bidStatus(saleId: string, commit: string): Promise<BidStatus>;
  isClaimed(saleId: string, account: string): Promise<boolean>;
  /** NEAR to attach to `finalize`, sized from the sale's actual input_data (sale view, or estimate for older wasm). */
  finalizeDeposit(saleId: string): Promise<FinalizeDeposit>;
  /** Arrival time (unix ms) per slot, if the backend knows it. The chain views do not expose it. */
  bidTimes(saleId: string): Promise<number[] | null>;
  payToken(token: string | null): Promise<PayToken>;
  accessKeys(account: string): Promise<KeyCheck>;
  /** Mock-only conveniences */
  mockFastForward?(saleId: string): Promise<void>;
}

export const api: Api = MOCK ? mockApi : chainApi;

export type { TxCall };
