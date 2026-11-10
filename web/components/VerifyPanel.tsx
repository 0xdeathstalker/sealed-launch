"use client";
import { hex, resultToWire, type ClearingResult } from "sealedlaunch-clearing";
import { compareWithChain } from "@/lib/claim";
import { shortHash } from "@/lib/format";
import type { BidSlot, ClearingSummary, RevealedBid, SaleInfo } from "@/lib/types";
import { Note, Pill } from "./ui";

export function VerifyPanel({ saleId, info, clearing, result, slots, revealed }: {
  saleId: string; info: SaleInfo; clearing: ClearingSummary; result: ClearingResult; slots: BidSlot[]; revealed: (RevealedBid | null)[];
}) {
  const checks = compareWithChain(result, clearing);
  const allOk = checks.every((c) => c.ok);
  const p = info.params;

  const download = () => {
    const doc = {
      params: { sale_id: saleId, supply: p.auction_supply, reserve: p.reserve_price, token_decimals: p.token_decimals, min_size: p.min_size },
      entries: slots.map((s, i) => ({ bidder: s.bidder, commit: s.commit, deposit: s.deposit, plaintext: revealed[i] ?? null })),
      onchain: clearing,
      recomputed: resultToWire(result),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
    a.download = `${saleId}-verify-input.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {allOk ? <Pill kind="ok">recompute matches get_clearing</Pill> : <Pill kind="bad">MISMATCH with get_clearing</Pill>}
        <Pill kind={clearing.verified_onchain ? "ok" : "warn"}>{clearing.verified_onchain ? "contract recomputed on-chain" : "not recomputed on-chain (challenge window only)"}</Pill>
      </div>
      <p className="small muted">
        Your browser just fetched every <code>get_bid</code> and <code>get_revealed_bids</code> from the sale contract and ran
        the same <code>clear()</code> as the contract (the shared <code>sealedlaunch-clearing</code> library), then compared
        the result with <code>get_clearing</code>.
      </p>
      <div className="scroll">
        <table>
          <thead><tr><th>Field</th><th>Recomputed here</th><th>On-chain</th><th /></tr></thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.label}>
                <td>{c.label}</td>
                <td className="hash">{c.mine.length > 40 ? shortHash(c.mine, 10) : c.mine}</td>
                <td className="hash">{c.chain.length > 40 ? shortHash(c.chain, 10) : c.chain}</td>
                <td style={{ color: c.ok ? "var(--ok)" : "var(--bad)", fontWeight: 700 }}>{c.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        What this proves: the published result is consistent with the plaintexts the contract stored. What it cannot prove
        by itself: that the TEE published a plaintext for every valid bid. A falsely dropped bid shows up as a missing
        plaintext; its owner can prove it with their salt via <code>challenge</code> (that is why you keep the receipt).
      </Note>
      <div className="row">
        <button className="btn sm" onClick={download}>Download inputs as JSON</button>
        <span className="small muted">alloc_root {shortHash(hex(result.allocRoot), 8)} · {result.leaves.length} leaves</span>
      </div>
    </div>
  );
}
