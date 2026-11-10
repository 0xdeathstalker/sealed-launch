import { sha256 } from "@noble/hashes/sha256";
import { concat, str, u128be, u32be, hex, unhex, cmpBytes, enc } from "./bytes";
import { Leaf, leafHash, merkleRoot } from "./merkle";

export interface Bid { price: bigint; size: bigint; salt: Uint8Array }
export interface Params { saleId: string; supply: bigint; reserve: bigint; tokenDecimals: number; minSize: bigint }
export interface Entry { bidder: string; commit: Uint8Array; deposit: bigint; plaintext: Bid | null }
export type Outcome = { dropped: number } | { filled: bigint };
export interface ClearingResult {
  pStar: bigint; supply: bigint; sold: bigint; burned: bigint; raise: bigint; totalDeposits: bigint;
  inputHash: Uint8Array; allocRoot: Uint8Array; leaves: Leaf[]; outcomes: Outcome[];
}
export const DropReason = { NoPlaintext: 1, CommitMismatch: 2, BadBid: 3, BelowReserve: 4, Underfunded: 5 } as const;
export const MAX_SIZE = 1n << 100n;
export const MAX_ENTRIES = 65536;
const U128_MAX = (1n << 128n) - 1n;

export function bidBytes(b: Bid): Uint8Array {
  if (b.salt.length !== 32) throw new Error("salt must be 32 bytes");
  return concat(u128be(b.price), u128be(b.size), b.salt);
}
export function parseBidBytes(p: Uint8Array): Bid | null {
  if (p.length !== 64) return null;
  const rd = (o: number) => { let x = 0n; for (let i = 0; i < 16; i++) x = (x << 8n) | BigInt(p[o + i]); return x; };
  return { price: rd(0), size: rd(16), salt: p.slice(32, 64) };
}
export function commitHash(b: Bid, bidder: string, saleId: string): Uint8Array {
  return sha256(concat(bidBytes(b), str(bidder), str(saleId)));
}
const pow10 = (d: number) => 10n ** BigInt(d);
/** ceil(price*tokens/10^D); null if > u128 */
export function cost(price: bigint, tokens: bigint, decimals: number): bigint | null {
  const s = pow10(decimals);
  const c = (price * tokens + s - 1n) / s;
  return c > U128_MAX ? null : c;
}
export function inputHash(saleId: string, entries: { bidder: string; commit: Uint8Array; deposit: bigint }[]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode("SL1/input"), str(saleId), u32be(entries.length)];
  for (const e of entries) parts.push(str(e.bidder), e.commit, u128be(e.deposit));
  return sha256(concat(...parts));
}

export function clear(params: Params, entries: Entry[]): ClearingResult {
  const { supply, reserve, tokenDecimals: D, minSize, saleId } = params;
  if (entries.length > MAX_ENTRIES) throw new Error("too many entries");
  if (supply < 1n || supply > MAX_SIZE) throw new Error("bad supply");
  if (reserve < 1n) throw new Error("bad reserve");
  if (D < 0 || D > 38) throw new Error("bad decimals");

  const outcomes: Outcome[] = new Array(entries.length);
  const valid: { i: number; price: bigint; size: bigint }[] = [];
  entries.forEach((e, i) => {
    const b = e.plaintext;
    if (!b) { outcomes[i] = { dropped: 1 }; return; }
    if (hex(commitHash(b, e.bidder, saleId)) !== hex(e.commit)) { outcomes[i] = { dropped: 2 }; return; }
    if (b.price === 0n || b.size === 0n || b.size < minSize || b.size > MAX_SIZE) { outcomes[i] = { dropped: 3 }; return; }
    if (b.price < reserve) { outcomes[i] = { dropped: 4 }; return; }
    const c = cost(b.price, b.size, D);
    if (c === null || c > e.deposit) { outcomes[i] = { dropped: 5 }; return; }
    outcomes[i] = { filled: 0n };
    valid.push({ i, price: b.price, size: b.size });
  });

  const byPrice = new Map<bigint, typeof valid>();
  for (const v of valid) { const l = byPrice.get(v.price); l ? l.push(v) : byPrice.set(v.price, [v]); }
  const prices = [...byPrice.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const fill = new Map<number, bigint>();
  let cum = 0n, pStar = reserve, sold = 0n, burned = 0n, found = false;
  for (const p of prices) {
    const lvl = byPrice.get(p)!;
    const m = lvl.reduce((s, v) => s + v.size, 0n);
    if (cum + m >= supply) {
      found = true; pStar = p;
      const R = supply - cum;
      const base = new Map<number, bigint>(); const rem = new Map<number, bigint>();
      let sum = 0n;
      for (const v of lvl) { const x = v.size * R; base.set(v.i, x / m); rem.set(v.i, x % m); sum += x / m; }
      let left = R - sum;
      const order = lvl.map((v) => v.i).filter((i) => rem.get(i)! > 0n).sort((a, b) => {
        const ra = rem.get(a)!, rb = rem.get(b)!;
        if (ra !== rb) return ra > rb ? -1 : 1;
        const c = cmpBytes(entries[a].commit, entries[b].commit);
        return c !== 0 ? c : a - b;
      });
      for (const i of order) { if (left === 0n) break; base.set(i, base.get(i)! + 1n); left -= 1n; }
      if (left !== 0n) throw new Error("largest remainder invariant");
      for (const [i, f] of base) fill.set(i, f);
      for (const v of valid) { if (v.price > p) fill.set(v.i, v.size); else if (v.price < p) fill.set(v.i, 0n); }
      sold = supply; burned = 0n;
      break;
    }
    cum += m;
  }
  if (!found) {
    for (const v of valid) fill.set(v.i, v.size);
    sold = cum; burned = supply - cum; pStar = reserve;
  }
  for (const [i, f] of fill) outcomes[i] = { filled: f };

  const agg = new Map<string, { tokens: bigint; deposit: bigint }>();
  entries.forEach((e, i) => {
    const a = agg.get(e.bidder) ?? { tokens: 0n, deposit: 0n };
    a.deposit += e.deposit;
    const o = outcomes[i]; if ("filled" in o) a.tokens += o.filled;
    agg.set(e.bidder, a);
  });
  const names = [...agg.keys()].sort((a, b) => cmpBytes(enc.encode(a), enc.encode(b)));
  const leaves: Leaf[] = []; let raise = 0n, totalDeposits = 0n, refunds = 0n;
  for (const n of names) {
    const { tokens, deposit } = agg.get(n)!;
    const c = cost(pStar, tokens, D);
    if (c === null || c > deposit) throw new Error("refund underflow");
    const refund = deposit - c;
    raise += c; refunds += refund; totalDeposits += deposit;
    if (tokens === 0n && refund === 0n) continue;
    leaves.push({ bidder: n, tokens, refund });
  }
  if (totalDeposits !== raise + refunds) throw new Error("conservation violated");
  return {
    pStar, supply, sold, burned, raise, totalDeposits,
    inputHash: inputHash(saleId, entries), allocRoot: merkleRoot(leaves.map(leafHash)), leaves, outcomes,
  };
}
