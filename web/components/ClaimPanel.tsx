"use client";
import { useMemo, useState } from "react";
import type { ClearingResult } from "sealedlaunch-clearing";
import { claimFor } from "@/lib/claim";
import { TGAS } from "@/lib/config";
import { formatUnits } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import type { ClearingSummary, PayToken, SaleInfo } from "@/lib/types";
import { ActionStatus, Note, Pill, useAction } from "./ui";

export function ClaimPanel({ saleId, info, clearing, result, pay, claimed, onDone }: {
  saleId: string; info: SaleInfo; clearing: ClearingSummary; result: ClearingResult; pay: PayToken;
  claimed: (account: string) => boolean | null; onDone: () => void;
}) {
  const w = useWallet();
  const [other, setOther] = useState("");
  const who = other.trim() || w.account;
  const D = info.params.token_decimals;
  const data = useMemo(() => (who ? claimFor(result, who, clearing.alloc_root) : null), [who, result, clearing.alloc_root]);
  const done = who ? claimed(who) : null;

  const go = useAction(async () => {
    if (!w.account) throw new Error("Connect a wallet first");
    if (!who || !data) throw new Error("Nothing to claim");
    if (!data.proofValid) throw new Error("Local Merkle proof does not verify against alloc_root. Do not send.");
    const tx = await w.call({
      receiverId: saleId, methodName: "claim",
      args: { bidder: who, index: data.index, tokens: data.tokens.toString(), refund: data.refund.toString(), proof: data.proof },
      gas: 150n * TGAS, deposit: 0n,
    });
    onDone();
    return tx.redirected ? "Wallet redirected: approve there, then reload." : `Claim sent${tx.note ? `: ${tx.note}` : ""}`;
  });

  return (
    <div className="card">
      <h2>Claim and refund</h2>
      {!who ? <p className="muted">Connect a wallet to see your allocation.</p> : null}
      {who && !data ? (
        <Note>No allocation for <span className="mono">{who}</span>: this account either did not bid or all of its bids were dropped with nothing to refund.</Note>
      ) : null}
      {who && data ? (
        <>
          <p style={{ fontSize: "1.05rem" }}>
            <span className="mono">{who}</span> {data.tokens > 0n ? <>gets <strong>{formatUnits(data.tokens, D, 4)} {info.params.symbol}</strong> at P* = <strong>{formatUnits(BigInt(clearing.p_star), pay.decimals, 8)} {pay.symbol}</strong></> : "gets no tokens"}
            {data.refund > 0n ? <> and a refund of <strong>{formatUnits(data.refund, pay.decimals, 8)} {pay.symbol}</strong></> : null}.
          </p>
          <div className="row">
            {data.proofValid ? <Pill kind="ok">Merkle proof verified locally against alloc_root</Pill> : <Pill kind="bad">proof does not verify</Pill>}
            {done ? <Pill kind="ok">already claimed</Pill> : done === null ? <Pill>claim status unknown</Pill> : <Pill kind="warn">not claimed yet</Pill>}
          </div>
          <details style={{ margin: "10px 0" }}>
            <summary className="small muted" style={{ cursor: "pointer" }}>Proof (leaf #{data.index} of {result.leaves.length})</summary>
            <pre className="code">{JSON.stringify({ bidder: who, index: data.index, tokens: data.tokens.toString(), refund: data.refund.toString(), proof: data.proof }, null, 2)}</pre>
          </details>
          <button className="btn primary block" disabled={go.busy || !!done || !data.proofValid || !w.account} onClick={() => go.run()}>
            {go.busy ? "Sending…" : done ? "Already claimed" : "Claim tokens and refund"}
          </button>
          <ActionStatus error={go.error} msg={go.msg} />
        </>
      ) : null}
      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: "pointer" }}>Look up or claim for another account</summary>
        <p className="small muted">Anyone may submit a claim; the tokens and refund always go to the bidder.</p>
        <input type="text" value={other} onChange={(e) => setOther(e.target.value)} placeholder="account.testnet" />
      </details>
    </div>
  );
}
