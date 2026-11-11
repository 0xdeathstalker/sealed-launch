// Reads a sale from chain and recomputes the clearing with clearing-js.
import { createHash } from "node:crypto";
import {
  clear, cost, hex, unhex, leafHash, merkleProof, verifyProof, paramsFromWire, entryFromWire,
  type ClearingResult, type Entry,
} from "sealedlaunch-clearing";
import { view, rpc } from "./chain.ts";

export interface SaleInfo {
  status: string; refund_mode: boolean; mode: string; bid_count: number; deposits_total: string; fees_accrued: string;
  lp_status: string; voided: boolean; cleared_at_ns: string; challenge_end_ns: string; in_flight: boolean;
  params: {
    auction_supply: string; reserve_price: string; token_decimals: number; min_size: string; bid_fee: string;
    bid_end_ms: string; lp_bps: number; lp_token_reserve: string; creator: string; factory: string; max_bids: number;
    payment_token: string | null; finalize_timeout_secs: number; challenge_secs: number; [k: string]: unknown;
  };
}
/** `ts` (ms) is optional: the redeployed factory adds it, older sales do not have it. */
export interface Slot { bidder: string; commit: string; ciphertext: string; deposit: string; ts?: string | number | null }
export interface Revealed { price: string; size: string; salt: string }
export interface Clearing {
  p_star: string; sold: string; burned: string; raise: string; alloc_root: string; leaf_count: number;
  input_hash: string; status: string; verified_onchain: boolean;
}

export async function pmap<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i], i); }
  }));
  return out;
}

export interface ChainSale {
  sale: string; info: SaleInfo; slots: Slot[]; revealed: (Revealed | null)[]; clearing: Clearing | null;
}

export async function fetchSale(sale: string): Promise<ChainSale> {
  const info = await view<SaleInfo>(sale, "get_sale");
  const n = await view<number>(sale, "get_bid_count");
  const slots = await pmap(Array.from({ length: n }, (_, i) => i), 8, (idx) => view<Slot>(sale, "get_bid", { idx }));
  let revealed: (Revealed | null)[] = [];
  try {
    for (let from = 0; from < n; from += 50) {
      revealed.push(...(await view<(Revealed | null)[]>(sale, "get_revealed_bids", { from, limit: 50 })));
    }
  } catch { revealed = []; }
  const clearing = await view<Clearing | null>(sale, "get_clearing");
  return { sale, info, slots, revealed, clearing };
}

export interface Recomputed {
  result: ClearingResult;
  perBidder: { bidder: string; tokens: bigint; refund: bigint; cost: bigint; deposit: bigint; proofOk: boolean }[];
  sumDeposits: bigint; sumRefunds: bigint;
  /** per slot: filled tokens or drop code */
  outcomes: ({ filled: bigint } | { dropped: number })[];
}

export function recompute(cs: ChainSale): Recomputed {
  const p = cs.info.params;
  const params = paramsFromWire({
    sale_id: cs.sale, supply: p.auction_supply, reserve: p.reserve_price, token_decimals: p.token_decimals, min_size: p.min_size,
  });
  const entries: Entry[] = cs.slots.map((s, i) =>
    entryFromWire({ bidder: s.bidder, commit: s.commit, deposit: s.deposit, plaintext: cs.revealed[i] ?? null }));
  const result = clear(params, entries);
  const lh = result.leaves.map(leafHash);
  const D = p.token_decimals;
  const dep = new Map<string, bigint>();
  for (const e of entries) dep.set(e.bidder, (dep.get(e.bidder) ?? 0n) + e.deposit);
  const perBidder = result.leaves.map((l, i) => ({
    bidder: l.bidder, tokens: l.tokens, refund: l.refund, deposit: dep.get(l.bidder) ?? 0n,
    cost: cost(result.pStar, l.tokens, D) ?? 0n,
    proofOk: verifyProof(lh[i], i, lh.length, merkleProof(lh, i), result.allocRoot),
  }));
  let sumDeposits = 0n; for (const e of entries) sumDeposits += e.deposit;
  let sumRefunds = 0n; for (const l of result.leaves) sumRefunds += l.refund;
  return { result, perBidder, sumDeposits, sumRefunds, outcomes: result.outcomes as any };
}

/** sha256 of the deployed wasm via RPC view_code (hex). */
export async function codeHashHex(account: string): Promise<string | null> {
  try {
    const r = await rpc<{ code_base64: string }>("query", { request_type: "view_code", finality: "final", account_id: account });
    return createHash("sha256").update(Buffer.from(r.code_base64, "base64")).digest("hex");
  } catch { return null; }
}
export { hex, unhex };

// ---------------------------------------------------------------- finalize deposit
// OutLayer admission floor, mirrored from contracts/sale `outlayer_required_deposit` (and outlayer.testnet
// `estimate_execution_cost`): base 0.001 + max_instructions/1e6 * 1e-10 + 60 s * 1000 * 1e-7 NEAR
// + 1e-5 NEAR per input_data byte beyond 32 KiB (refundable hold). Unused NEAR is refunded to the caller.
const OL_BASE_FEE = 10n ** 21n;
const OL_PER_MINSTR = 10n ** 14n;
const OL_PER_MS = 10n ** 17n;
const OL_FREE_BYTES = 32 * 1024;
const OL_PER_BYTE = 10n ** 19n;
const MILLI = 10n ** 21n;
export const maxInstructions = (n: number) => 3_000_000_000n + 2_000_000_000n * BigInt(Math.ceil(n / 100));
export function outlayerRequiredDeposit(inputLen: number, n: number): bigint {
  if (n === 0) return 0n;
  const compute = OL_BASE_FEE + (maxInstructions(n) / 1_000_000n) * OL_PER_MINSTR + 60_000n * OL_PER_MS;
  return compute + BigInt(Math.max(0, inputLen - OL_FREE_BYTES)) * OL_PER_BYTE;
}
/** required + 25% (headroom capped at 1 NEAR), rounded up to 0.001 NEAR. Same as the contract view. */
export function recommendedDeposit(required: bigint): bigint {
  if (required === 0n) return 0n;
  let h = required / 4n; if (h > 10n ** 24n) h = 10n ** 24n;
  const r = required + h;
  return ((r + MILLI - 1n) / MILLI) * MILLI;
}
/** Byte length of the sale's `input_data` estimated from its stored slots (key order/escaping as serde_json). */
export function estimateInputLen(slots: Slot[]): number {
  // {"action":"clear","entries":[...],"params":{sale_id,supply,reserve,token_decimals,min_size,code_hash(64),bid_end_ms}}
  let len = 400;
  for (const s of slots) {
    const ct = s.ciphertext.startsWith("0x") ? s.ciphertext.length - 2 : s.ciphertext.length;
    len += `{"bidder":"","ciphertext":"","commit":"","deposit":""},`.length + s.bidder.length + ct + 64 + s.deposit.length;
  }
  return len;
}
export interface FinalizeDeposit { required: bigint; recommended: bigint; inputLen: number; source: "contract" | "estimate" }
/** What to attach to `finalize`: the sale's `get_finalize_deposit` view, or (older sale wasm without the
 *  view) a client-side estimate from the stored slots with the same formula and headroom. */
export async function finalizeDeposit(sale: string, slots?: Slot[]): Promise<FinalizeDeposit> {
  try {
    const d = await view<{ required: string; recommended: string; input_len: number }>(sale, "get_finalize_deposit", {});
    return { required: BigInt(d.required), recommended: BigInt(d.recommended), inputLen: Number(d.input_len), source: "contract" };
  } catch {
    const s = slots ?? (await fetchSale(sale)).slots;
    const inputLen = estimateInputLen(s);
    const required = outlayerRequiredDeposit(inputLen, s.length);
    return { required, recommended: recommendedDeposit(required), inputLen, source: "estimate" };
  }
}
