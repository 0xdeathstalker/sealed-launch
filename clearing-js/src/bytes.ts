export const enc = new TextEncoder();
export function concat(...p: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of p) n += a.length;
  const o = new Uint8Array(n); let i = 0;
  for (const a of p) { o.set(a, i); i += a.length; }
  return o;
}
export function u128be(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 128n) throw new RangeError("u128 out of range");
  const o = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
}
export function u32be(x: number): Uint8Array {
  const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, x, false); return o;
}
export function str(s: string): Uint8Array {
  const b = enc.encode(s); return concat(u32be(b.length), b);
}
export function hex(b: Uint8Array): string {
  let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s;
}
export function unhex(h: string): Uint8Array {
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("bad hex");
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
/** raw UTF-8 byte comparison */
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
