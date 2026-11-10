"use client";
import { formatUnits } from "@/lib/format";

export interface Point { price: bigint; size: bigint }

/** Cumulative demand at price >= x (step curve), supply line, P* line, filled region. Plain SVG. */
export function DemandChart({ bids, pStar, supply, tokenDecimals, payDecimals, paySymbol, symbol }: {
  bids: Point[]; pStar: bigint; supply: bigint; tokenDecimals: number; payDecimals: number; paySymbol: string; symbol: string;
}) {
  const num = (v: bigint, d: number) => Number(formatUnits(v, d, 12).replace(/,/g, ""));
  const W = 640, H = 300, L = 58, R = 30, T = 14, B = 40;

  const levels = new Map<bigint, bigint>();
  for (const b of bids) levels.set(b.price, (levels.get(b.price) ?? 0n) + b.size);
  const prices = [...levels.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length === 0) return <p className="muted">No valid revealed bids to draw.</p>;

  const px = prices.map((p) => num(p, payDecimals));
  const cum: number[] = new Array(prices.length);
  let run = 0;
  for (let i = prices.length - 1; i >= 0; i--) { run += num(levels.get(prices[i])!, tokenDecimals); cum[i] = run; }
  const sup = num(supply, tokenDecimals);
  const ps = num(pStar, payDecimals);
  const xmin = Math.min(px[0], ps) * 0.9, xmax = Math.max(px[px.length - 1], ps) * 1.08;
  const ymax = Math.max(cum[0], sup) * 1.08;
  const X = (v: number) => L + ((v - xmin) / (xmax - xmin || 1)) * (W - L - R);
  const Y = (v: number) => H - B - (v / ymax) * (H - T - B);

  // curve: y(x) = cum[i] for x in (px[i-1], px[i]]
  let d = `M ${X(xmin)} ${Y(cum[0])}`;
  for (let i = 0; i < px.length; i++) {
    d += ` H ${X(px[i])}`;
    d += ` V ${Y(i + 1 < px.length ? cum[i + 1] : 0)}`;
  }
  // filled region: right of P*, under min(curve, supply). Right after P* the height is the demand strictly above P*.
  const aboveIdx = px.map((p, i) => (p > ps ? i : -1)).filter((i) => i >= 0);
  let area = "";
  if (aboveIdx.length) {
    area = `M ${X(ps)} ${Y(0)} V ${Y(Math.min(cum[aboveIdx[0]], sup))}`;
    for (const i of aboveIdx) area += ` H ${X(px[i])} V ${Y(i + 1 < px.length ? Math.min(cum[i + 1], sup) : 0)}`;
    area += " Z";
  }

  const ticks = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const fx = (v: number) => (v >= 1 ? v.toFixed(3) : v.toPrecision(2)).replace(/\.?0+$/, "");
  const fy = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)));

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Demand curve with clearing price ${fx(ps)} ${paySymbol}`}>
        {ticks(0, ymax, 4).map((v) => (
          <g key={`y${v}`}>
            <line className="grid-l" x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
            <text x={L - 6} y={Y(v) + 4} textAnchor="end">{fy(v)}</text>
          </g>
        ))}
        {ticks(xmin, xmax, 5).map((v) => (
          <text key={`x${v}`} x={X(v)} y={H - B + 16} textAnchor="middle">{fx(v)}</text>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle">price per {symbol} ({paySymbol})</text>
        <text x={12} y={(T + H - B) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>cumulative {symbol} demanded</text>
        <path className="fill" d={area} />
        <path className="curve" d={d} />
        <line className="supply" x1={L} x2={W - R} y1={Y(sup)} y2={Y(sup)} />
        <line className="pstar" x1={X(ps)} x2={X(ps)} y1={T} y2={H - B} />
        <text x={X(ps) + 5} y={T + 11} style={{ fill: "var(--c2)", fontWeight: 700 }}>P* = {fx(ps)}</text>
        <text x={W - R - 2} y={Y(sup) - 5} textAnchor="end">supply {fy(sup)}</text>
        {px.map((p, i) => (
          <circle key={i} cx={X(p)} cy={Y(cum[i])} r={3} fill="var(--c1)"><title>{`bid level ${fx(p)} ${paySymbol}: ${fy(cum[i])} ${symbol} demanded at this price or higher`}</title></circle>
        ))}
      </svg>
      <div className="legend">
        <span><i style={{ background: "var(--c1)" }} />cumulative demand at price ≥ x</span>
        <span><i style={{ background: "var(--c2)" }} />clearing price P*</span>
        <span><i style={{ background: "var(--muted)" }} />supply for sale</span>
        <span><i style={{ background: "var(--c1)", opacity: 0.3, height: 9 }} />filled (the level at P* is pro-rata)</span>
      </div>
    </div>
  );
}
