"use client";
import type { ClearingResult } from "sealedlaunch-clearing";
import { formatUnits } from "@/lib/format";
import type { BidSlot, RevealedBid } from "@/lib/types";

interface Props {
  slots: BidSlot[]; revealed: (RevealedBid | null)[]; result: ClearingResult; times: number[] | null;
  tokenDecimals: number; payDecimals: number; paySymbol: string; symbol: string; me: string | null;
}

export function SniperBoard({ slots, revealed, result, times, tokenDecimals, payDecimals, paySymbol, symbol, me }: Props) {
  const rows = new Map<string, { n: number; first: number; firstT: number | null; maxPrice: bigint; tokens: bigint; refund: bigint }>();
  slots.forEach((s, i) => {
    if (!s.commit || /^0+$/.test(s.commit)) return; // cancelled
    const r = rows.get(s.bidder) ?? { n: 0, first: i, firstT: times ? times[i] : null, maxPrice: 0n, tokens: 0n, refund: 0n };
    r.n += 1;
    const rv = revealed[i];
    if (rv && BigInt(rv.price) > r.maxPrice) r.maxPrice = BigInt(rv.price);
    if (times && (r.firstT === null || times[i] < r.firstT)) r.firstT = times[i];
    rows.set(s.bidder, r);
  });
  for (const l of result.leaves) { const r = rows.get(l.bidder); if (r) { r.tokens = l.tokens; r.refund = l.refund; } }
  const t0 = times && times.length ? Math.min(...times) : null;
  const list = [...rows.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first);
  const multi = list.filter(([, r]) => r.n >= 3);
  const fmtP = (v: bigint) => formatUnits(v, payDecimals, 8);

  const when = (r: { first: number; firstT: number | null }) => {
    if (r.firstT === null || t0 === null) return `slot #${r.first}`;
    const dt = r.firstT - t0;
    const rel = dt < 60_000 ? `+${(dt / 1000).toFixed(1)}s` : dt < 3600_000 ? `+${Math.round(dt / 60_000)}m` : `+${(dt / 3600_000).toFixed(1)}h`;
    return `#${r.first} (${rel} after first bid)`;
  };

  return (
    <div>
      <p className="small muted">
        Bids per account in arrival order. Everyone with a fill paid the same <strong>P* = {fmtP(result.pStar)} {paySymbol}</strong> per {symbol}, whatever they bid or whenever they arrived.
        {times === null ? " Block timestamps are not exposed by the contract views, so arrival is shown as slot order only." : ""}
      </p>
      {multi.length ? (
        <div className="note">
          {multi.length === 1 ? "1 account" : `${multi.length} accounts`} placed 3 or more bids ({multi.map(([a, r]) => `${a} ×${r.n}`).join(", ")}). Marked as multi-bidders (a simple heuristic, not proof of a bot).
        </div>
      ) : null}
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Account</th><th className="num">Bids</th><th>First arrival</th><th className="num">Highest bid</th><th className="num">Filled ({symbol})</th><th className="num">Paid per token</th></tr>
          </thead>
          <tbody>
            {list.map(([acct, r]) => (
              <tr key={acct} className={`${acct === me ? "me" : ""} ${r.n >= 3 ? "bot" : ""}`}>
                <td className="mono">{acct}{acct === me ? " (you)" : ""}{r.n >= 3 ? " · multi-bid" : ""}</td>
                <td className="num">{r.n}</td>
                <td>{when(r)}</td>
                <td className="num">{r.maxPrice ? fmtP(r.maxPrice) : "–"}</td>
                <td className="num">{formatUnits(r.tokens, tokenDecimals, 2)}</td>
                <td className="num">{r.tokens > 0n ? `${fmtP(result.pStar)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
