"use client";
import { useMemo, useState } from "react";
import { MAX_SIZE } from "sealedlaunch-clearing";
import { ftBidCall, nearBidCall, requiredDeposit, saveReceipt, sealBid, type Receipt } from "@/lib/bid";
import { formatUnits, parseUnits } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import type { PayToken, SaleInfo } from "@/lib/types";
import { ActionStatus, Field, Note, Unit, useAction } from "./ui";

export function BidForm({ saleId, info, pay, pk, onSent }: {
  saleId: string; info: SaleInfo; pay: PayToken; pk: string | null; onSent: (r: Receipt) => void;
}) {
  const w = useWallet();
  const p = info.params;
  const D = p.token_decimals;
  const [priceS, setPriceS] = useState("");
  const [tokensS, setTokensS] = useState("");
  const [padS, setPadS] = useState("");
  const [last, setLast] = useState<Receipt | null>(null);

  const v = useMemo(() => {
    const errs: string[] = [];
    const price = parseUnits(priceS, pay.decimals);
    const size = parseUnits(tokensS, D);
    const reserve = BigInt(p.reserve_price), minSize = BigInt(p.min_size), fee = BigInt(p.bid_fee);
    if (price === null || price === 0n) errs.push(priceS ? "price is not a valid amount" : "enter your max price per token");
    else if (price < reserve) errs.push(`price is below the reserve (${formatUnits(reserve, pay.decimals, 8)} ${pay.symbol})`);
    if (size === null || size === 0n) errs.push(tokensS ? "token amount is not valid" : "enter how many tokens");
    else if (size < minSize) errs.push(`below the minimum size (${formatUnits(minSize, D)} ${p.symbol})`);
    else if (size > MAX_SIZE) errs.push("size too large");
    const cost = price && size ? requiredDeposit(price, size, D) : null;
    if (price && size && cost === null) errs.push("cost overflows u128");
    let deposit = cost;
    if (padS.trim()) {
      const pd = parseUnits(padS, pay.decimals);
      if (pd === null) errs.push("deposit is not a valid amount");
      else if (cost !== null && pd < cost) errs.push("deposit must be at least the cost");
      else deposit = pd;
    }
    const total = deposit !== null ? deposit + fee : null;
    return { errs, price, size, cost, deposit, fee, total };
  }, [priceS, tokensS, padS, pay, D, p]);

  const send = useAction(async () => {
    if (!w.account) throw new Error("Connect a wallet first");
    if (!pk) throw new Error("The sale has no encryption key yet (get_pubkey is empty). Bidding is not possible.");
    if (v.errs.length || !v.price || !v.size || v.deposit === null) throw new Error(v.errs[0] ?? "Invalid bid");
    const sealed = sealBid({ pkHex: pk, saleId, bidder: w.account, price: v.price, size: v.size });
    const receipt: Receipt = {
      v: 1, saleId, bidder: w.account, commit: sealed.commitHex, salt: sealed.saltHex, price: v.price.toString(), size: v.size.toString(),
      deposit: v.deposit.toString(), ciphertext: sealed.ciphertextHex, createdAt: Date.now(),
    };
    // Persist the salt BEFORE the wallet can redirect away: it is needed for challenges and cannot be recovered.
    saveReceipt(receipt);
    setLast(receipt);
    onSent(receipt);
    const call = p.payment_token
      ? ftBidCall(p.payment_token, saleId, w.account, sealed, v.deposit + v.fee)
      : nearBidCall(saleId, sealed, v.fee, v.deposit);
    const tx = await w.call(call);
    if (tx.txHash) { const r2 = { ...receipt, txHash: tx.txHash }; saveReceipt(r2); setLast(r2); onSent(r2); }
    return tx.redirected ? "Wallet redirected. Your sealed receipt is saved in this browser; reload the sale page after approving." : "Bid sent. Check the receipt below for its on-chain status.";
  });

  const sym = pay.symbol;
  const quickPad = (mult: bigint) => v.cost !== null && setPadS(formatUnits(v.cost * mult, pay.decimals, pay.decimals));

  return (
    <div className="card">
      <h2>Place a sealed bid</h2>
      <p className="small muted">
        Your price and size are encrypted in your browser to the sale&apos;s TEE key before anything is sent. You pay the single
        clearing price P* (never more than your max), and anything above that is refunded.
      </p>
      <div className="two">
        <Field label="Max price per token" hint={`Reserve ${formatUnits(BigInt(p.reserve_price), pay.decimals, 8)} ${sym}`}>
          <Unit unit={sym}><input type="text" inputMode="decimal" value={priceS} onChange={(e) => setPriceS(e.target.value)} placeholder="0.0020" /></Unit>
        </Field>
        <Field label="Tokens wanted" hint={`Min ${formatUnits(BigInt(p.min_size), D)} ${p.symbol}`}>
          <Unit unit={p.symbol}><input type="text" inputMode="decimal" value={tokensS} onChange={(e) => setTokensS(e.target.value)} placeholder="50000" /></Unit>
        </Field>
      </div>
      <details>
        <summary className="small muted" style={{ cursor: "pointer", marginBottom: 8 }}>Deposit amount (public, optional padding)</summary>
        <Field label={`Deposit (${sym})`} hint="Deposits are public on-chain. A deposit equal to price × size reveals your bid. Depositing more than the cost hides it; the unused part is refunded after clearing.">
          <input type="text" inputMode="decimal" value={padS} onChange={(e) => setPadS(e.target.value)} placeholder={v.cost !== null ? `${formatUnits(v.cost, pay.decimals, 8)} (exact cost)` : "exact cost"} />
        </Field>
        <div className="row" style={{ marginBottom: 10 }}>
          <button type="button" className="btn sm" onClick={() => setPadS("")}>Exact</button>
          <button type="button" className="btn sm" onClick={() => quickPad(2n)} disabled={v.cost === null}>2× cost</button>
          <button type="button" className="btn sm" onClick={() => quickPad(5n)} disabled={v.cost === null}>5× cost</button>
        </div>
      </details>
      <dl className="kv">
        <dt>Cost at your max price</dt><dd>{v.cost !== null ? `${formatUnits(v.cost, pay.decimals, 8)} ${sym}` : "…"}</dd>
        <dt>Deposit (escrowed)</dt><dd>{v.deposit !== null ? `${formatUnits(v.deposit, pay.decimals, 8)} ${sym}` : "…"}</dd>
        <dt>Bid fee (non-refundable)</dt><dd>{formatUnits(v.fee, pay.decimals, 8)} {sym}</dd>
        <dt>You send</dt><dd><strong>{v.total !== null ? `${formatUnits(v.total, pay.decimals, 8)} ${sym}` : "…"}</strong> {p.payment_token ? `via ${p.payment_token}.ft_transfer_call` : "attached to bid()"}</dd>
      </dl>
      {v.errs.length && (priceS || tokensS) ? <Note kind="warn">{v.errs[0]}</Note> : null}
      {!pk ? <Note kind="bad">This sale has no encryption key yet, so it cannot take bids.</Note> : null}
      <button className="btn primary block" disabled={send.busy || v.errs.length > 0 || !w.account || !pk} onClick={() => send.run()}>
        {send.busy ? "Encrypting and sending…" : w.account ? "Encrypt and commit bid" : "Connect a wallet to bid"}
      </button>
      {!w.account ? <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={w.connect}>Connect wallet</button></div> : null}
      <ActionStatus error={send.error} msg={send.msg} />
      {last ? <Note>Sealed. Commit <span className="hash">{last.commit}</span> was generated in your browser and the salt was saved locally. Download the backup from the receipts panel.</Note> : null}
    </div>
  );
}
