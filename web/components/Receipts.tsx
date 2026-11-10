"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { downloadReceipt, loadReceipts, type Receipt } from "@/lib/bid";
import { formatUnits, shortHash } from "@/lib/format";
import { explorerTx } from "@/lib/config";
import { useWallet } from "@/lib/wallet";
import type { PayToken, SaleInfo } from "@/lib/types";
import { ActionStatus, CopyButton, Pill, useAction } from "./ui";

function Row({ r, saleId, info, pay, canCancel, refresh }: { r: Receipt; saleId: string; info: SaleInfo; pay: PayToken; canCancel: boolean; refresh: () => void }) {
  const w = useWallet();
  const [st, setSt] = useState<{ state: string; idx: number | null; reason: string | null } | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    let dead = false;
    const run = () => api.bidStatus(saleId, r.commit).then((s) => !dead && setSt(s)).catch(() => !dead && setSt(null));
    run();
    const t = setInterval(run, 8000);
    return () => { dead = true; clearInterval(t); };
  }, [saleId, r.commit, info.bid_count]);
  const cancel = useAction(async () => {
    if (st?.idx == null) throw new Error("slot index unknown");
    await w.call({ receiverId: saleId, methodName: "cancel_bid", args: { idx: st.idx }, gas: 60n * 10n ** 12n, deposit: 0n });
    refresh();
    return "Cancelled. The deposit is refunded; the bid fee is kept.";
  });
  const D = info.params.token_decimals;
  return (
    <div className="card flat" style={{ marginBottom: 10 }}>
      <div className="row sp">
        <div className="row">
          {st?.state === "accepted" ? <Pill kind="ok">on-chain, slot #{st.idx}</Pill>
            : st?.state === "unclaimed" ? <Pill kind="bad">not accepted: {st.reason ?? "see unclaimed"}</Pill>
            : <Pill kind="warn">not seen on-chain yet</Pill>}
          <span className="small muted">{new Date(r.createdAt).toLocaleString()}</span>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => downloadReceipt(r)}>Download salt backup</button>
          {canCancel && st?.state === "accepted" ? <button className="btn sm" disabled={cancel.busy} onClick={() => cancel.run()}>Cancel bid</button> : null}
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Commit</dt><dd className="hash">{r.commit} <CopyButton text={r.commit} /></dd>
        <dt>Deposit</dt><dd>{formatUnits(BigInt(r.deposit), pay.decimals, 8)} {pay.symbol}</dd>
        <dt>Your bid</dt>
        <dd>
          {show ? `${formatUnits(BigInt(r.size), D, 6)} ${info.params.symbol} at max ${formatUnits(BigInt(r.price), pay.decimals, 8)} ${pay.symbol}` : "hidden (stored only in this browser)"}{" "}
          <button className="btn sm" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
        </dd>
        <dt>Salt</dt><dd className="hash">{show ? r.salt : shortHash(r.salt, 4)}</dd>
        {r.txHash ? (<><dt>Tx</dt><dd><a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">{shortHash(r.txHash, 8)}</a></dd></>) : null}
      </dl>
      <ActionStatus error={cancel.error} msg={cancel.msg} />
    </div>
  );
}

export function Receipts({ saleId, info, pay, canCancel, version }: { saleId: string; info: SaleInfo; pay: PayToken; canCancel: boolean; version: number }) {
  const w = useWallet();
  const [list, setList] = useState<Receipt[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!w.account) { setList([]); return; }
    setList(loadReceipts(saleId, w.account).sort((a, b) => b.createdAt - a.createdAt));
  }, [saleId, w.account, version, n]);
  if (!w.account || list.length === 0) return null;
  return (
    <div className="card">
      <h2>Your sealed receipts</h2>
      <p className="small muted">
        The salt exists only in this browser (and your downloaded backup). It is needed to prove your bid if the TEE ever
        drops it. Lose it and you cannot challenge.
      </p>
      {list.map((r) => <Row key={r.commit} r={r} saleId={saleId} info={info} pay={pay} canCancel={canCancel} refresh={() => setN((x) => x + 1)} />)}
    </div>
  );
}
