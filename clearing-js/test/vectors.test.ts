import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { commitHash, clear, inputHash, hex, unhex, leafHash, merkleRoot, merkleProof, verifyProof, recomputeFromChain, resultToWire,
  paramsFromWire, entryFromWire, encryptBid, decryptBid, bidBytes, Bid } from "../src/index";
import { PrivateKey } from "eciesjs";

const V = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../clearing/vectors.json"), "utf8"));

describe("commit vectors", () => {
  for (const [k, c] of V.commit_vectors.entries()) it(`commit ${k}`, () => {
    const b: Bid = { price: BigInt(c.price), size: BigInt(c.size), salt: unhex(c.salt) };
    expect(hex(commitHash(b, c.bidder, c.sale))).toBe(c.commit);
    expect(hex(bidBytes(b))).toBe(c.plaintext_hex);
  });
});

describe("merkle vectors", () => {
  for (const m of V.merkle_vectors) it(`merkle n=${m.n}`, () => {
    const lh = m.leaf_hashes.map(unhex);
    expect(hex(merkleRoot(lh))).toBe(m.root);
    const root = unhex(m.root);
    m.proofs.forEach((p: string[], i: number) => {
      expect(merkleProof(lh, i).map(hex)).toEqual(p);
      expect(verifyProof(lh[i], i, m.n, p.map(unhex), root)).toBe(true);
      expect(verifyProof(lh[i], i, m.n, [...p.map(unhex), new Uint8Array(32)], root)).toBe(false);
    });
  });
});

describe("clearing vectors", () => {
  for (const c of V.clearing_vectors) it(c.name, () => {
    const e = c.expected;
    expect(c.params.sale_id).toBeTruthy();
    const w = recomputeFromChain(c.entries, c.params);
    expect(w.p_star).toBe(e.p_star); expect(w.sold).toBe(e.sold); expect(w.burned).toBe(e.burned);
    expect(w.raise).toBe(e.raise); expect(w.total_deposits).toBe(e.total_deposits);
    expect(w.input_hash).toBe(e.input_hash); expect(w.alloc_root).toBe(e.alloc_root);
    expect(w.leaves).toEqual(e.leaves.map((l: any) => ({ bidder: l.bidder, tokens: l.tokens, refund: l.refund })));
    expect(w.outcomes).toEqual(e.outcomes.map((o: any) => ("filled" in o ? { filled: o.filled } : { code: o.code })));
    const r = clear(paramsFromWire(c.params), c.entries.map(entryFromWire));
    r.leaves.forEach((l, i) => expect(hex(leafHash(l))).toBe(e.leaves[i].leaf_hash));
    // proofs round-trip
    const lh = r.leaves.map(leafHash);
    lh.forEach((h, i) => expect(verifyProof(h, i, lh.length, merkleProof(lh, i), r.allocRoot)).toBe(true));
    expect(hex(inputHash(c.params.sale_id, c.entries.map(entryFromWire)))).toBe(e.input_hash);
  });
});

describe("ecies", () => {
  it("roundtrip", () => {
    const sk = new PrivateKey();
    const bid: Bid = { price: 5n, size: 10n, salt: new Uint8Array(32).fill(7) };
    const ct = encryptBid(sk.publicKey.toHex(true), bid);
    expect(/^[0-9a-f]+$/.test(ct)).toBe(true);
    expect(decryptBid(hex(new Uint8Array(sk.secret)), ct)).toEqual(bid);
    expect(decryptBid(hex(new Uint8Array(new PrivateKey().secret)), ct)).toBeNull();
  });
});

// deterministic PRNG
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe("property: permutation invariance", () => {
  it("shuffled entries give identical economics; per-bidder allocation identical", () => {
    const sale = "sale-p.t";
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed); const D = [0, 6, 18, 24][seed % 4];
      const n = 1 + Math.floor(r() * 20);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const bidder = `u${Math.floor(r() * 8)}.t`; // repeated bidders
        const price = BigInt(1 + Math.floor(r() * 5)) * 10n ** BigInt(Math.max(D - 3, 0));
        const size = BigInt(1 + Math.floor(r() * 50)) * (D > 3 ? 10n ** BigInt(D - 2) : 1n);
        const salt = new Uint8Array(32).map(() => Math.floor(r() * 256));
        const bid = { price, size, salt };
        const c = cost(price, size, D)!;
        const good = r() > 0.15;
        entries.push({ bidder, commit: commitHash(bid, bidder, sale), deposit: good ? c : c / 2n, plaintext: r() > 0.1 ? bid : null });
      }
      const params = { saleId: sale, supply: BigInt(10 + Math.floor(r() * 100)) * (D > 3 ? 10n ** BigInt(D - 2) : 1n), reserve: 10n ** BigInt(Math.max(D - 3, 0)), tokenDecimals: D, minSize: 1n };
      const a = clear(params, entries);
      const perm = entries.map((e, i) => ({ e, k: r(), i })).sort((x, y) => x.k - y.k);
      const b = clear(params, perm.map((x) => x.e));
      for (const f of ["pStar", "sold", "burned", "raise", "totalDeposits"] as const) expect(b[f]).toBe(a[f]);
      expect(hex(b.allocRoot)).toBe(hex(a.allocRoot));
      expect(b.leaves).toEqual(a.leaves);
      // outcomes: price-level fills for non-marginal bids invariant; sum of fills equal
      const sum = (x: typeof a) => x.outcomes.reduce((s, o) => s + ("filled" in o ? o.filled : 0n), 0n);
      expect(sum(b)).toBe(sum(a)); expect(sum(a)).toBe(a.sold);
      expect(a.sold + a.burned).toBe(a.supply);
      expect(a.raise + a.leaves.reduce((s, l) => s + l.refund, 0n)).toBe(a.totalDeposits);
    }
  });
});
import { cost } from "../src/index";
