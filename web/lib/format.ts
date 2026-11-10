/** Decimal string -> base units. Returns null on bad input or too many fraction digits. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const t = s.trim().replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt((i || "0") + f.padEnd(decimals, "0"));
}

/** Base units -> trimmed decimal string, optionally limited to `maxFrac` fraction digits (truncating). */
export function formatUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, "0");
  if (frac.length > maxFrac) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, "");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}

/** Like formatUnits but never shows "0" for a nonzero value (shows "<0.000001"). */
export function formatUnitsSmart(v: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(v, decimals, maxFrac);
  if (v > 0n && s === "0") return "<" + (maxFrac > 0 ? "0." + "0".repeat(maxFrac - 1) + "1" : "1");
  return s;
}

export const shortHash = (h: string, n = 8) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
export const isZeroHex = (h: string) => /^0*$/.test(h);

export function countdown(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  return `${m}m ${r}s`;
}
