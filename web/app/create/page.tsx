"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { CODE_HASH, FACTORY, MOCK, OUTLAYER_PROJECT, TGAS, explorerTx } from "@/lib/config";
import { formatUnits, parseUnits } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { usePoll } from "@/lib/hooks";
import { KeyCheck } from "@/components/KeyCheck";
import { ActionStatus, Field, Note, Unit, useAction } from "@/components/ui";
import type { CreateParamsWire, TxResult } from "@/lib/types";

const NAME_RE = /^[a-z0-9]([a-z0-9_-]{0,38}[a-z0-9])?$/;

export default function CreatePage() {
  const w = useWallet();
  const [f, setF] = useState({
    name: "", tokenName: "", symbol: "", decimals: "18", paymentToken: "",
    supply: "1000000", reserve: "0.0005", minSize: "1000", fee: "0.01",
    hours: "24", lpPct: "20", creatorPct: "10", vestDays: "30", challenge: "300", maxBids: "200",
    project: OUTLAYER_PROJECT, codeHash: CODE_HASH,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const saleId = `sale-${f.name}.${FACTORY}`;
  const nameOk = NAME_RE.test(f.name);
  const D = Number(f.decimals);
  const payToken = f.paymentToken.trim() || null;

  const pay = usePoll(() => api.payToken(payToken), `pay:${payToken}`, 0);
  const payDec = pay.data?.decimals ?? (payToken ? null : 24);
  const paySym = pay.data?.symbol ?? "NEAR";

  const taken = usePoll(async () => (nameOk ? api.factorySale(f.name) : null), `name:${f.name}:${nameOk}`, 0);
  const dep = usePoll(() => api.requiredDeposit(), "dep", 0);

  const calc = useMemo(() => {
    const errs: string[] = [];
    if (!Number.isInteger(D) || D < 0 || D > 24) errs.push("decimals must be 0..24");
    if (payDec === null) errs.push("payment token metadata not loaded");
    const supply = Number.isInteger(D) && D >= 0 && D <= 24 ? parseUnits(f.supply, D) : null;
    const reserve = payDec !== null ? parseUnits(f.reserve, payDec) : null;
    const minSize = Number.isInteger(D) && D >= 0 && D <= 24 ? parseUnits(f.minSize, D) : null;
    const fee = payDec !== null ? parseUnits(f.fee, payDec) : null;
    const lp = Number(f.lpPct), cr = Number(f.creatorPct), hours = Number(f.hours);
    if (!supply || supply < 1n) errs.push("auction supply must be > 0");
    if (!reserve || reserve < 1n) errs.push("reserve price must be > 0");
    if (minSize === null) errs.push("min bid size is invalid");
    if (fee === null) errs.push("bid fee is invalid");
    if (!(lp >= 0 && lp <= 100)) errs.push("LP % must be 0..100");
    if (!(cr >= 0 && cr <= 100)) errs.push("creator % must be 0..100");
    if (!(hours > 0)) errs.push("bid window must be > 0 hours");
    if (!f.name || !nameOk) errs.push("name must be lowercase a-z 0-9 - _ (no leading/trailing - _)");
    if (!f.symbol) errs.push("ticker required");
    if (!f.tokenName) errs.push("token name required");
    if (!/^[0-9a-fA-F]{64}$/.test(f.codeHash)) errs.push("code hash must be 64 hex chars");
    if (!f.project.includes("/")) errs.push("OutLayer project must be owner/project");
    let derived = null as null | { lpBps: number; lpTokens: bigint; creatorTokens: bigint; total: bigint };
    if (supply && lp >= 0 && lp <= 100 && cr >= 0 && cr <= 100) {
      const lpBps = Math.round(lp * 100);
      const lpTokens = (supply * BigInt(lpBps) + 9999n) / 10000n; // ceil
      const creatorTokens = (supply * BigInt(Math.round(cr * 100))) / 10000n;
      derived = { lpBps, lpTokens, creatorTokens, total: supply + lpTokens + creatorTokens };
    }
    return { errs, supply, reserve, minSize, fee, derived, hours };
  }, [f, D, payDec, nameOk]);

  const [result, setResult] = useState<{ tx: TxResult; saleId: string } | null>(null);

  const submit = useAction(async () => {
    if (calc.errs.length || !calc.derived || !calc.supply || !calc.reserve || calc.minSize === null || calc.fee === null) throw new Error(calc.errs[0] ?? "Invalid form");
    if (!w.account) throw new Error("Connect a wallet first");
    if (dep.data == null) throw new Error("Could not read the factory's required deposit");
    const p: CreateParamsWire = {
      name: f.name, symbol: f.symbol, token_name: f.tokenName, icon: null, token_decimals: D,
      auction_supply: calc.supply.toString(), lp_token_reserve: calc.derived.lpTokens.toString(),
      creator_supply: calc.derived.creatorTokens.toString(), reserve_price: calc.reserve.toString(),
      min_size: calc.minSize.toString(), bid_fee: calc.fee.toString(), payment_token: payToken,
      bid_end_ms: String(Date.now() + Math.round(calc.hours * 3600_000)), challenge_secs: Number(f.challenge),
      lp_bps: calc.derived.lpBps, vesting_secs: Math.round(Number(f.vestDays) * 86400),
      outlayer_project: f.project, code_hash: f.codeHash.toLowerCase(), max_bids: Number(f.maxBids),
    };
    const tx = await w.call({ receiverId: FACTORY, methodName: "create_sale", args: { p }, gas: 300n * TGAS, deposit: dep.data });
    setResult({ tx, saleId });
    return tx.redirected ? "Wallet redirected: approve there, then return to the sale link below." : "Submitted.";
  });

  // polling the new sale for its key check + pubkey
  const created = usePoll(async () => {
    if (!result) return null;
    try { return await api.factorySale(f.name); } catch { return null; }
  }, `created:${result?.saleId}`, result ? 4000 : 0);

  const pct = (n: bigint) => (calc.derived ? Number((n * 10000n) / calc.derived.total) / 100 : 0);

  return (
    <>
      <h1>Create a sale</h1>
      <p className="muted" style={{ maxWidth: "70ch" }}>
        One transaction to the factory creates the sale account <em>without any access key</em>, deploys the sale
        contract, and has the TEE derive the sale&apos;s encryption key. Below you can check, with a live RPC call, that the
        account really has 0 access keys.
      </p>
      {MOCK ? <Note kind="warn">Mock mode: submitting creates an in-memory sale in this browser tab only.</Note> : null}
      <div className="grid cols-main">
        <div className="card">
          <h2>Token and sale</h2>
          <div className="two">
            <Field label="Sale name (account label)" hint={nameOk ? (taken.data ? <span style={{ color: "var(--bad)" }}>already taken</span> : "available") : f.name ? "invalid" : "lowercase a-z, 0-9, - _"}>
              <input type="text" value={f.name} onChange={set("name")} placeholder="moonrat" autoCapitalize="none" />
            </Field>
            <Field label="Ticker"><input type="text" value={f.symbol} onChange={set("symbol")} placeholder="MRAT" /></Field>
          </div>
          <Field label="Token name"><input type="text" value={f.tokenName} onChange={set("tokenName")} placeholder="Moon Rat" /></Field>
          <div className="two">
            <Field label="Auction supply" hint="Whole tokens sold in the sealed auction.">
              <Unit unit={f.symbol || "tokens"}><input type="text" inputMode="decimal" value={f.supply} onChange={set("supply")} /></Unit>
            </Field>
            <Field label="Reserve price" hint={`Minimum price, ${paySym} per whole token.`}>
              <Unit unit={paySym}><input type="text" inputMode="decimal" value={f.reserve} onChange={set("reserve")} /></Unit>
            </Field>
          </div>
          <div className="two">
            <Field label="Bid window" hint="From the moment you submit.">
              <Unit unit="hours"><input type="text" inputMode="decimal" value={f.hours} onChange={set("hours")} /></Unit>
            </Field>
            <Field label="Min bid size" hint="Whole tokens.">
              <Unit unit={f.symbol || "tokens"}><input type="text" inputMode="decimal" value={f.minSize} onChange={set("minSize")} /></Unit>
            </Field>
          </div>
          <h3 style={{ marginTop: 12 }}>Where the money and tokens go</h3>
          <div className="two">
            <Field label="Liquidity pool share of raise" hint="Percent of the raise paired with LP tokens at P*. The sale account holds the LP, and it has no keys.">
              <Unit unit="%"><input type="text" inputMode="decimal" value={f.lpPct} onChange={set("lpPct")} /></Unit>
            </Field>
            <Field label="Creator allocation" hint="Percent of auction supply, minted extra and vested linearly.">
              <Unit unit="%"><input type="text" inputMode="decimal" value={f.creatorPct} onChange={set("creatorPct")} /></Unit>
            </Field>
          </div>
          <div className="two">
            <Field label="Creator vesting"><Unit unit="days"><input type="text" inputMode="decimal" value={f.vestDays} onChange={set("vestDays")} /></Unit></Field>
            <Field label="Bid fee (non-refundable)"><Unit unit={paySym}><input type="text" inputMode="decimal" value={f.fee} onChange={set("fee")} /></Unit></Field>
          </div>
          <details>
            <summary className="small muted" style={{ cursor: "pointer", marginBottom: 10 }}>Advanced</summary>
            <div className="two">
              <Field label="Token decimals"><input type="text" inputMode="numeric" value={f.decimals} onChange={set("decimals")} /></Field>
              <Field label="Payment token" hint="Empty = native NEAR. Otherwise a NEP-141 account id."><input type="text" value={f.paymentToken} onChange={set("paymentToken")} placeholder="(NEAR)" /></Field>
              <Field label="Challenge window (s)"><input type="text" inputMode="numeric" value={f.challenge} onChange={set("challenge")} /></Field>
              <Field label="Max bids (≤ 65536)"><input type="text" inputMode="numeric" value={f.maxBids} onChange={set("maxBids")} /></Field>
            </div>
            <Field label="OutLayer project"><input type="text" value={f.project} onChange={set("project")} /></Field>
            <Field label="Worker code hash (sha256 of the OutLayer wasm)" hint="Recorded in the sale at init. Must match the build the secret is locked to.">
              <input type="text" value={f.codeHash} onChange={set("codeHash")} className="mono" />
            </Field>
          </details>
        </div>

        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h2>Result preview</h2>
            <dl className="kv">
              <dt>Sale + token account</dt><dd className="mono">{saleId}</dd>
              <dt>Auction</dt><dd>{calc.supply ? formatUnits(calc.supply, D, 4) : "?"} {f.symbol}{calc.derived ? ` (${pct(calc.supply!)}%)` : ""}</dd>
              <dt>LP reserve</dt><dd>{calc.derived ? `${formatUnits(calc.derived.lpTokens, D, 4)} ${f.symbol} (${pct(calc.derived.lpTokens)}%)` : "?"}</dd>
              <dt>Creator</dt><dd>{calc.derived ? `${formatUnits(calc.derived.creatorTokens, D, 4)} ${f.symbol} (${pct(calc.derived.creatorTokens)}%)` : "?"}</dd>
              <dt>Total minted</dt><dd>{calc.derived ? `${formatUnits(calc.derived.total, D, 4)} ${f.symbol}` : "?"}</dd>
              <dt>Raise range</dt><dd>{calc.supply && calc.reserve && payDec !== null ? `≥ ${formatUnits((calc.reserve * calc.supply) / 10n ** BigInt(D), payDec, 4)} ${paySym} if fully sold` : "?"}</dd>
              <dt>Factory deposit</dt><dd>{dep.data != null ? `${formatUnits(dep.data, 24, 3)} NEAR (get_required_deposit)` : dep.error ? "unreadable" : "…"}</dd>
            </dl>
            <p className="small muted" style={{ marginTop: 10 }}>
              LP tokens reserve = LP share of the auction supply (an upper bound on what the LP needs, any unused part is burned at settle).
            </p>
            {calc.errs.length ? <Note kind="warn">{calc.errs[0]}{calc.errs.length > 1 ? ` (+${calc.errs.length - 1} more)` : ""}</Note> : null}
            <button className="btn primary block" disabled={submit.busy || calc.errs.length > 0 || !w.account} onClick={() => submit.run()}>
              {submit.busy ? "Waiting for wallet…" : w.account ? "Create sale" : "Connect a wallet to create"}
            </button>
            {!w.account && !MOCK ? <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={w.connect}>Connect wallet</button></div> : null}
            <ActionStatus error={submit.error} msg={submit.msg} />
          </div>

          <div className="card">
            <h2>0 access keys check</h2>
            <p className="small muted">
              The account <span className="mono">{saleId}</span> is created by the factory in one atomic batch with no AddKey
              action. This is a live <code>view_access_key_list</code> RPC call, not a claim.
            </p>
            {nameOk ? <KeyCheck key={saleId + (result ? "w" : "")} account={saleId} watch={!!result} /> : <p className="muted small">Enter a valid name first.</p>}
            {result ? (
              <div style={{ marginTop: 12 }}>
                <dl className="kv">
                  <dt>Factory status</dt><dd>{created.data ? `${created.data.status}${created.data.pubkey ? "" : " (waiting for pk_sale)"}` : "not visible yet (the create call may still be running)"}</dd>
                  {result.tx.txHash ? (<><dt>Tx</dt><dd><a href={explorerTx(result.tx.txHash)} target="_blank" rel="noreferrer">{result.tx.txHash}</a></dd></>) : null}
                </dl>
                <Link className="btn" href={`/sale/${result.saleId}`}>Open sale page</Link>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
