import { sha256 } from "@noble/hashes/sha256";
import { concat, str, u128be, hex, unhex } from "./bytes";

export interface Leaf { bidder: string; tokens: bigint; refund: bigint }

export const leafHash = (l: Leaf): Uint8Array =>
  sha256(concat(new Uint8Array([0]), str(l.bidder), u128be(l.tokens), u128be(l.refund)));
const node = (a: Uint8Array, b: Uint8Array) => sha256(concat(new Uint8Array([1]), a, b));

function levels(leaves: Uint8Array[]): Uint8Array[][] {
  const out = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const nx: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) nx.push(i + 1 < cur.length ? node(cur[i], cur[i + 1]) : cur[i]);
    out.push(nx); cur = nx;
  }
  return out;
}

export function merkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) return new Uint8Array(32);
  const l = levels(leafHashes); return l[l.length - 1][0];
}

export function merkleProof(leafHashes: Uint8Array[], index: number): Uint8Array[] {
  if (!(index >= 0 && index < leafHashes.length)) throw new RangeError("index out of range");
  const lv = levels(leafHashes); const proof: Uint8Array[] = [];
  let idx = index;
  for (let d = 0; d < lv.length - 1; d++) {
    const n = lv[d].length;
    if (!(n % 2 === 1 && idx === n - 1)) proof.push(lv[d][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Uint8Array, index: number, leafCount: number, proof: Uint8Array[], root: Uint8Array): boolean {
  if (!(index >= 0 && index < leafCount)) return false;
  let h = leaf, idx = index, n = leafCount, p = 0;
  while (n > 1) {
    if (!(n % 2 === 1 && idx === n - 1)) {
      if (p >= proof.length) return false;
      const s = proof[p++];
      h = idx % 2 === 0 ? node(h, s) : node(s, h);
    }
    idx = Math.floor(idx / 2); n = Math.ceil(n / 2);
  }
  return p === proof.length && hex(h) === hex(root);
}
export { hex, unhex };
