import { Params, Entry, Bid, ClearingResult, clear } from "./clearing";
import { hex, unhex } from "./bytes";

export interface WireParams { sale_id: string; supply: string; reserve: string; token_decimals: number; min_size: string }
export interface WireEntry { bidder: string; commit: string; deposit: string; plaintext: { price: string; size: string; salt: string } | null }

export const paramsFromWire = (p: WireParams): Params => ({
  saleId: p.sale_id, supply: BigInt(p.supply), reserve: BigInt(p.reserve), tokenDecimals: p.token_decimals, minSize: BigInt(p.min_size),
});
export const entryFromWire = (e: WireEntry): Entry => ({
  bidder: e.bidder, commit: unhex(e.commit), deposit: BigInt(e.deposit),
  plaintext: e.plaintext ? { price: BigInt(e.plaintext.price), size: BigInt(e.plaintext.size), salt: unhex(e.plaintext.salt) } : null,
});
export const plaintextToWire = (b: Bid | null) => (b ? { price: b.price.toString(), size: b.size.toString(), salt: hex(b.salt) } : null);

export function resultToWire(r: ClearingResult) {
  return {
    p_star: r.pStar.toString(), supply: r.supply.toString(), sold: r.sold.toString(), burned: r.burned.toString(),
    raise: r.raise.toString(), total_deposits: r.totalDeposits.toString(),
    input_hash: hex(r.inputHash), alloc_root: hex(r.allocRoot),
    leaf_count: r.leaves.length,
    leaves: r.leaves.map((l) => ({ bidder: l.bidder, tokens: l.tokens.toString(), refund: l.refund.toString() })),
    outcomes: r.outcomes.map((o) => ("filled" in o ? { filled: o.filled.toString() } : { code: o.dropped })),
  };
}

/**
 * Recompute everything from on-chain slots + revealed plaintexts (wire/JSON shapes).
 * Used by scripts/verify: compare returned fields to the contract's get_clearing().
 */
export function recomputeFromChain(entries: WireEntry[], params: WireParams) {
  return resultToWire(clear(paramsFromWire(params), entries.map(entryFromWire)));
}
