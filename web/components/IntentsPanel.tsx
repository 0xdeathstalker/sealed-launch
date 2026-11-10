"use client";
import { INTENTS } from "@/lib/config";
import type { SaleInfo } from "@/lib/types";
import { Note } from "./ui";

/**
 * DISPLAY ONLY. This panel documents the flow researched in INTENTS.md. It makes no network calls and sends
 * nothing. The path has not been run end to end and Intents has no testnet.
 */
export function IntentsPanel({ saleId, info }: { saleId: string; info: SaleInfo }) {
  const p = info.params;
  const tmpl = {
    dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100,
    originAsset: "nep141:sol.omft.near", depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:<payment token on NEAR mainnet, e.g. wrap.near>",
    amount: "<deposit + bid fee, in the payment token's base units>",
    refundTo: "<your address on the origin chain>", refundType: "ORIGIN_CHAIN",
    recipient: "<mainnet sale account>", recipientType: "DESTINATION_CHAIN",
    customRecipientMsg: JSON.stringify({ v: 1, sale_id: "<mainnet sale account>", ciphertext: "<hex>", commit: "<hex>", bidder: "<your NEAR account, receives refunds>", refund_to: null }),
    deadline: "<ISO 8601, in the future>",
  };
  return (
    <div className={`card ${INTENTS ? "" : "disabled"}`} aria-disabled={!INTENTS}>
      <div className="row sp">
        <h2 style={{ margin: 0 }}>Bid from another chain (mainnet, experimental)</h2>
        <span className={`pill ${INTENTS ? "warn" : ""}`}>{INTENTS ? "documentation only" : "disabled"}</span>
      </div>
      <Note kind="warn">
        Not available here. This section only <strong>describes</strong> a flow researched in <code>INTENTS.md</code>. It has not
        been run end to end, NEAR Intents has no testnet, and this app does not call 1Click or move any funds. The 1Click
        field it relies on, <code>customRecipientMsg</code>, is labelled &quot;HIGHLY EXPERIMENTAL&quot; by its API.
        {!INTENTS ? <> Set <code>NEXT_PUBLIC_INTENTS=1</code> at build time to show the details.</> : null}
      </Note>
      {INTENTS ? (
        <>
          <p className="small muted">Documented flow (this sale is on testnet, so this would apply to a mainnet sale, not <span className="mono">{saleId}</span>):</p>
          <ol className="steps small">
            <li>Prepare a sealed bid exactly as above (encrypt to the sale key, compute the commit). The <code>msg</code> must be at most 1024 characters.</li>
            <li>Ask 1Click for a quote from ETH, SOL or BTC to the sale&apos;s payment token with <code>recipient</code> = the sale account and <code>customRecipientMsg</code> = the bid JSON (request shape below). Use <code>EXACT_OUTPUT</code> so the sale receives a known amount.</li>
            <li>Send the quoted amount to the returned deposit address on the origin chain.</li>
            <li>1Click swaps and the Intents verifier calls <code>ft_transfer_call(sale, amount, msg)</code> on the token. The sale&apos;s <code>ft_on_transfer</code> sees the verifier as <code>sender_id</code>, so the bidder identity is the <code>bidder</code> field inside <code>msg</code>.</li>
            <li>Poll <code>GET /v0/status</code> and the sale&apos;s <code>bid_status(commit)</code> to see the bid land.</li>
          </ol>
          <pre className="code">{JSON.stringify(tmpl, null, 2)}</pre>
          <ul className="small muted" style={{ paddingLeft: "1.1rem" }}>
            <li><code>msg</code> is unauthenticated: anyone can claim any <code>bidder</code>. The commit binds the bidder, so a copied <code>msg</code> only funds that bid.</li>
            <li>A transfer the sale cannot turn into a bid is kept as &quot;unclaimed&quot; and pulled back with <code>claim_refund</code> to a NEAR account. It is not returned to the origin chain automatically.</li>
            <li>Fees seen on dry quotes: a 0.2% app fee and a withdraw fee; real swaps may differ.</li>
            <li>Sale payment token here: <span className="mono">{p.payment_token ?? "native NEAR (not supported by this path; needs wrap.near or another NEP-141)"}</span>.</li>
            <li>Fallback that needs no experimental field: swap to your own NEAR account with 1Click, then bid with a normal wallet transaction.</li>
          </ul>
        </>
      ) : null}
    </div>
  );
}
