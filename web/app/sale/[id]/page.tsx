"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { MOCK, TGAS, explorerAccount } from "@/lib/config";
import { recompute } from "@/lib/claim";
import { countdown, formatUnits } from "@/lib/format";
import { useNow, usePoll } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import type { PayToken, SaleInfo } from "@/lib/types";
import { BidForm } from "@/components/BidForm";
import { ClaimPanel } from "@/components/ClaimPanel";
import { DemandChart } from "@/components/DemandChart";
import { IntentsPanel } from "@/components/IntentsPanel";
import { KeyCheck } from "@/components/KeyCheck";
import { Receipts } from "@/components/Receipts";
import { SniperBoard } from "@/components/SniperBoard";
import { VerifyPanel } from "@/components/VerifyPanel";
import { ActionStatus, CopyButton, Note, Pill, Stat, useAction } from "@/components/ui";

type Phase = "open" | "await-finalize" | "clearing" | "challenge" | "cleared" | "settled" | "refund";

function phaseOf(info: SaleInfo, now: number | null): Phase {
  if (info.refund_mode || info.status === "Refund") return "refund";
  const endMs = Number(info.params.bid_end_ms);
  switch (info.status) {
    case "Bidding": return now !== null && now >= endMs ? "await-finalize" : "open";
    case "Clearing": return "clearing";
    case "Challenge": {
      const ce = Number(BigInt(info.challenge_end_ns) / 1_000_000n);
      return now !== null && ce > 0 && now >= ce ? "cleared" : "challenge";
    }
    case "Cleared": return "cleared";
    case "Settled": return "settled";
  }
}

const PHASE_LABEL: Record<Phase, string> = {
  open: "Bidding open", "await-finalize": "Closed: waiting for finalize", clearing: "Clearing in the TEE",
  challenge: "Challenge window", cleared: "Cleared", settled: "Settled", refund: "Refund mode",
};

export default function SalePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const w = useWallet();
  const now = useNow(1000);
  const [rcpt, setRcpt] = useState(0);

  const info = usePoll(() => api.saleInfo(id), id, 7000);
  const sale = info.data;
  const payTok = sale?.params.payment_token ?? null;
  const payQ = usePoll(() => api.payToken(payTok), `pay:${id}:${payTok}:${sale ? 1 : 0}`, 0);
  const pk = usePoll(() => api.pubkey(id), `pk:${id}`, 0);
  const pay: PayToken | null = sale ? (payQ.data ?? (payTok ? null : { symbol: "NEAR", decimals: 24, account: null })) : null;

  const phase = sale ? phaseOf(sale, now) : null;
  const post = phase === "challenge" || phase === "cleared" || phase === "settled";
  const needSlots = post || phase === "refund";
  const count = sale?.bid_count ?? 0;
  const clearing = usePoll(() => api.clearing(id), `cl:${id}:${sale?.status}:${post}`, post ? 15000 : 0);
  const slots = usePoll(() => (needSlots ? api.bids(id, count) : Promise.resolve(null)), `slots:${id}:${count}:${needSlots}`, 0);
  const revealed = usePoll(() => (post ? api.revealed(id, count) : Promise.resolve(null)), `rev:${id}:${count}:${post}`, 0);
  const times = usePoll(() => api.bidTimes(id), `times:${id}:${count}`, 0);
  const finDep = usePoll(
    () => (phase === "await-finalize" || phase === "clearing" ? api.finalizeDeposit(id) : Promise.resolve(null)),
    `findep:${id}:${count}:${phase}`, 0,
  );
  const claimedQ = usePoll(
    async () => (w.account && post ? api.isClaimed(id, w.account) : null),
    `claimed:${id}:${w.account}:${post}:${rcpt}`, 0,
  );

  const analysis = useMemo(() => {
    if (!sale || !slots.data || !revealed.data) return null;
    if (slots.data.length !== count || revealed.data.length !== count) return null;
    try { return { ok: recompute(sale, slots.data, revealed.data, id), err: undefined }; }
    catch (e) { return { ok: undefined, err: e instanceof Error ? e.message : String(e) }; }
  }, [sale, slots.data, revealed.data, count, id]);

  const reload = () => { info.reload(); clearing.reload(); claimedQ.reload(); setRcpt((x) => x + 1); };

  const finalize = useAction(async () => {
    // OutLayer deposit sized from the bid set's input_data (+25% headroom); the unused part is refunded.
    const dep = await api.finalizeDeposit(id);
    const tx = await w.call({ receiverId: id, methodName: "finalize", args: {}, gas: 300n * TGAS, deposit: dep.recommended });
    reload();
    return tx.note ?? "Finalize sent. The TEE will clear and call back; this page refreshes itself.";
  });
  const settle = useAction(async () => {
    await w.call({ receiverId: id, methodName: "settle", args: {}, gas: 300n * TGAS, deposit: 0n });
    reload();
    return "Settle sent.";
  });

  if (info.error && !sale) {
    return (
      <>
        <h1>Sale not found</h1>
        <Note kind="bad">Could not read <code>get_sale</code> on <span className="mono">{id}</span>: {info.error}</Note>
        <p className="muted">The contracts may not be deployed, or this is not a sale account.</p>
        <Link href="/">Back to sales</Link>
      </>
    );
  }
  if (!sale || !phase || !pay) return <p className="muted">Loading sale…</p>;

  const p = sale.params;
  const D = p.token_decimals;
  const endMs = Number(p.bid_end_ms);
  const fmtTok = (v: string | bigint) => formatUnits(BigInt(v), D, 2);
  const fmtPay = (v: string | bigint, f = 6) => formatUnits(BigInt(v), pay.decimals, f);
  const result = analysis?.ok?.result ?? null;
  const cl = clearing.data;
  const loadingResult = post && (!cl || !analysis);

  return (
    <>
      <div className="row sp" style={{ marginBottom: 8 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{p.token_name} <span className="muted">({p.symbol})</span></h1>
          <div className="row small">
            <a className="mono" href={explorerAccount(id)} target="_blank" rel="noreferrer">{id}</a>
            <CopyButton text={id} />
            <span className="muted">token and sale are the same account</span>
          </div>
        </div>
        <Pill kind={phase === "open" ? "ok" : phase === "refund" ? "bad" : undefined}>{PHASE_LABEL[phase]}</Pill>
      </div>

      <div className="card flat" style={{ marginBottom: 16 }}>
        <div className="row sp">
          <strong>Keyless check</strong>
          <KeyCheck account={id} watch />
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 16 }}>
        <Stat k={phase === "open" ? "Closes in" : "Bid window"} v={now === null ? "…" : phase === "open" ? countdown(endMs - now) : "closed"} s={new Date(endMs).toLocaleString()} />
        <Stat k="For sale" v={`${fmtTok(p.auction_supply)} ${p.symbol}`} s={`reserve ${fmtPay(p.reserve_price, 8)} ${pay.symbol}`} />
        <Stat k="Sealed bids" v={String(sale.bid_count)} s={`max ${p.max_bids}`} />
        <Stat k="Deposits (public)" v={`${fmtPay(sale.deposits_total, 4)} ${pay.symbol}`} s="prices stay sealed" />
        {cl ? <Stat k="Clearing price P*" v={`${fmtPay(cl.p_star, 8)} ${pay.symbol}`} s={`sold ${fmtTok(cl.sold)} · burned ${fmtTok(cl.burned)}`} /> : null}
        {cl ? <Stat k="Raise" v={`${fmtPay(cl.raise, 4)} ${pay.symbol}`} s={`LP ${(p.lp_bps / 100).toFixed(0)}% · ${sale.lp_status}`} /> : null}
      </div>

      {phase === "open" ? (
        <div className="grid cols-main">
          <div className="grid" style={{ alignContent: "start" }}>
            <BidForm saleId={id} info={sale} pay={pay} pk={pk.data ?? null} onSent={() => { setRcpt((x) => x + 1); info.reload(); }} />
            <Receipts saleId={id} info={sale} pay={pay} canCancel version={rcpt} />
          </div>
          <div className="grid" style={{ alignContent: "start" }}>
            <div className="card">
              <h2>How this sale works</h2>
              <ol className="steps small">
                <li>You encrypt your max price and size to this sale&apos;s key. Only the TEE worker can decrypt, and only after the window closes.</li>
                <li>After close, anyone calls <code>finalize</code>. The TEE decrypts all bids, finds the single price P* where demand meets supply, and the contract checks the result.</li>
                <li>Every winner pays P*. Bids above P* get refunded the difference; bids below get everything back.</li>
                <li>What is visible now: bid count, depositor accounts and deposit sizes. What is hidden: prices and sizes.</li>
              </ol>
              <dl className="kv">
                <dt>Mode</dt><dd>{sale.mode === "Tee" ? "sealed bids (TEE)" : "commit-reveal fallback"}</dd>
                <dt>Encryption key</dt><dd className="hash">{pk.data ?? "not set"}</dd>
                <dt>Worker</dt><dd className="hash">{p.outlayer_project}<br />build {p.code_hash.slice(0, 16)}…</dd>
                <dt>Payment</dt><dd>{p.payment_token ?? "native NEAR"}</dd>
                <dt>Bid fee</dt><dd>{fmtPay(p.bid_fee, 8)} {pay.symbol} (non-refundable)</dd>
              </dl>
              {sale.mode === "Fallback" ? <Note kind="warn">This sale uses the commit-reveal fallback, which this UI does not support yet (no reveal step).</Note> : null}
            </div>
            {MOCK && phase === "open" ? (
              <div className="card flat">
                <strong>Mock controls</strong>
                <p className="small muted">Skips the clock so you can see clearing. Mock mode only.</p>
                <button className="btn sm" onClick={async () => { await api.mockFastForward?.(id); reload(); }}>Fast-forward to bid end</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {phase === "await-finalize" ? (
        <div className="card">
          <h2>The bid window closed</h2>
          <p>{sale.bid_count} sealed bids are waiting. Anyone can call <code>finalize</code>: it sends the ciphertexts to the OutLayer TEE worker, which decrypts and clears them. {sale.bid_count === 0 ? "With zero bids the contract clears on its own." : ""}</p>
          {finDep.data && finDep.data.recommended > 0n ? (
            <p>Finalize attaches {formatUnits(finDep.data.recommended, 24, 4)} NEAR for the OutLayer run ({finDep.data.inputLen.toLocaleString()} bytes of bids; minimum {formatUnits(finDep.data.required, 24, 4)} NEAR). Everything above the actual fee (about 0.001 NEAR) is refunded to you.</p>
          ) : null}
          <button className="btn primary" onClick={() => finalize.run()} disabled={finalize.busy || !w.account}>{finalize.busy ? "Sending…" : w.account ? "Finalize (needs about 300 Tgas)" : "Connect a wallet to finalize"}</button>
          <ActionStatus error={finalize.error} msg={finalize.msg} />
          <Receipts saleId={id} info={sale} pay={pay} canCancel={false} version={rcpt} />
        </div>
      ) : null}

      {phase === "clearing" ? (
        <div className="card">
          <h2>Clearing in the TEE</h2>
          <p>{sale.in_flight ? "The worker is running. " : ""}The contract is waiting for the TEE result. If it fails, <code>finalize</code> can be retried until the timeout; after that every bid is refundable.</p>
          <button className="btn" onClick={() => finalize.run()} disabled={finalize.busy || !w.account}>Retry finalize</button>
          <ActionStatus error={finalize.error} msg={finalize.msg} />
        </div>
      ) : null}

      {phase === "challenge" ? (
        <Note>
          Challenge window: the result is posted and anyone with a valid unrevealed or dropped bid can void the sale with their salt.
          {sale.challenge_end_ns !== "0" ? ` Ends ${new Date(Number(BigInt(sale.challenge_end_ns) / 1_000_000n)).toLocaleString()}.` : ""} Claims open after it ends.
        </Note>
      ) : null}

      {phase === "refund" ? (
        <RefundPanel saleId={id} info={sale} pay={pay} slots={slots.data} account={w.account} onDone={reload} />
      ) : null}

      {post ? (
        <div className="grid" style={{ gap: 16 }}>
          {loadingResult ? <p className="muted">Fetching all bids and recomputing… ({count} bids)</p> : null}
          {analysis?.err ? <Note kind="bad">Recompute failed: {analysis.err}</Note> : null}
          {cl && result && slots.data && revealed.data ? (
            <>
              <div className="grid cols-main">
                <ClaimPanel
                  saleId={id} info={sale} clearing={cl} result={result} pay={pay}
                  claimed={(a) => (a === w.account ? claimedQ.data : null)} onDone={reload}
                />
                <div className="card">
                  <h2>Settlement</h2>
                  <dl className="kv">
                    <dt>Status</dt><dd>{sale.status}{phase === "cleared" && sale.status === "Challenge" ? " (challenge ended; becomes Cleared on first claim)" : ""}</dd>
                    <dt>LP</dt><dd>{sale.lp_status}{sale.lp_status === "None" ? " (not started)" : ""}</dd>
                    <dt>Creator vested</dt><dd>{fmtTok(sale.creator_vested)} of {fmtTok(p.creator_supply)} {p.symbol}</dd>
                  </dl>
                  {phase === "cleared" ? (
                    <>
                      <p className="small muted" style={{ marginTop: 8 }}>Anyone can settle: it seeds the LP at P* from the sale account (keyless, so locked), burns unsold and unused tokens, pays the creator.</p>
                      <button className="btn" disabled={settle.busy || !w.account} onClick={() => settle.run()}>{settle.busy ? "Sending…" : "Settle"}</button>
                      <ActionStatus error={settle.error} msg={settle.msg} />
                    </>
                  ) : null}
                </div>
              </div>

              <div className="card">
                <h2>Demand curve</h2>
                <DemandChart
                  bids={result.outcomes.flatMap((o, i) => {
                    const r = revealed.data![i];
                    return r && !("code" in o) ? [{ price: BigInt(r.price), size: BigInt(r.size) }] : [];
                  })}
                  pStar={result.pStar} supply={result.supply} tokenDecimals={D} payDecimals={pay.decimals}
                  paySymbol={pay.symbol} symbol={p.symbol}
                />
                <p className="small muted">
                  Built from {result.outcomes.filter((o) => !("code" in o)).length} valid revealed bids
                  ({result.outcomes.filter((o) => "code" in o).length} dropped). {result.burned > 0n ? `Undersubscribed: P* is the reserve and ${fmtTok(result.burned)} ${p.symbol} are burned.` : "Oversubscribed: P* is the lowest price where cumulative demand reaches supply."}
                </p>
              </div>

              <div className="card">
                <h2>Sniper board</h2>
                <SniperBoard
                  slots={slots.data} revealed={revealed.data} result={result} times={times.data ?? null}
                  tokenDecimals={D} payDecimals={pay.decimals} paySymbol={pay.symbol} symbol={p.symbol} me={w.account}
                />
              </div>

              <div className="card">
                <h2>Verify it yourself</h2>
                <VerifyPanel saleId={id} info={sale} clearing={cl} result={result} slots={slots.data} revealed={revealed.data} />
              </div>
            </>
          ) : null}
          <Receipts saleId={id} info={sale} pay={pay} canCancel={false} version={rcpt} />
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}><IntentsPanel saleId={id} info={sale} /></div>
    </>
  );
}

function RefundPanel({ saleId, info, pay, slots, account, onDone }: {
  saleId: string; info: SaleInfo; pay: PayToken; slots: { bidder: string; deposit: string }[] | null; account: string | null; onDone: () => void;
}) {
  const w = useWallet();
  const mine = (slots ?? []).map((s, i) => ({ ...s, i })).filter((s) => s.bidder === account && BigInt(s.deposit) > 0n);
  const go = useAction(async (idx: number) => {
    await w.call({ receiverId: saleId, methodName: "refund", args: { idx }, gas: 60n * TGAS, deposit: 0n });
    onDone();
    return `Refund for slot #${idx} sent.`;
  });
  return (
    <div className="card">
      <h2>Refund mode</h2>
      <Note kind="bad">
        {info.voided ? "This sale was voided by a challenge." : "No valid clearing arrived in time."} Nobody is allocated tokens. Every deposit is refundable in full; bid fees are not returned.
      </Note>
      {!account ? <p className="muted">Connect a wallet to see your refunds.</p> : null}
      {account && slots && mine.length === 0 ? <p className="muted">No deposits from {account} (or they were already refunded).</p> : null}
      {mine.map((s) => (
        <div key={s.i} className="row sp" style={{ marginBottom: 6 }}>
          <span>Slot #{s.i}: {formatUnits(BigInt(s.deposit), pay.decimals, 8)} {pay.symbol}</span>
          <button className="btn sm" disabled={go.busy} onClick={() => go.run(s.i)}>Refund</button>
        </div>
      ))}
      <ActionStatus error={go.error} msg={go.msg} />
    </div>
  );
}
