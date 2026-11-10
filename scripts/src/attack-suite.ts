#!/usr/bin/env tsx
// Cheap live attacks from SEALED_LAUNCH section 9. Each attack must be REJECTED; records expected vs actual + tx link.
//
//   pnpm attack-suite --testnet --sale <acct|alias> [--attacker dsl-bidder3.testnet] [--dry] [--only a,b] [--allow-claim]
//
// Cost: gas of failed calls only (rejected calls refund attached deposits). --allow-claim lets the double-claim
// attack perform ONE legitimate first claim for an unclaimed bidder when nobody has claimed yet (moves that bidder's own funds to them).
import fs from "node:fs";
import path from "node:path";
import {
  parseArgs, requireTestnet, assertChainTestnet, resolveSale, die, loadDeployments, call, view, txLink, nowChainMs, SCRIPTS_DIR, TGAS, toYocto,
} from "./lib/chain.ts";
import { fetchSale, recompute } from "./lib/sale.ts";
import { assertOurSale } from "./lib/bids.ts";
import { leafHash, merkleProof, hex } from "sealedlaunch-clearing";

const a = parseArgs(process.argv.slice(2));
requireTestnet(a as any);
await assertChainTestnet();
const d = loadDeployments();
const sale = resolveSale(String(a.sale ?? die("--sale required")), d);
if (!sale.endsWith("." + d.factory.account)) die(`refusing: ${sale} is not a sub-account of factory ${d.factory.account}`);
const attacker = String(a.attacker ?? "dsl-bidder3.testnet");
const dry = !!a.dry;
const only = a.only ? String(a.only).split(",") : null;

const cs = await fetchSale(sale);
assertOurSale(sale, cs.info);
const info = cs.info;
const bidEnd = Number(info.params.bid_end_ms);
const chainNow = await nowChainMs();
const beforeDeadline = chainNow < bidEnd;

interface Row { attack: string; variant: string; expected: string; actual: string; verdict: string; tx?: string; link?: string; note?: string }
const rows: Row[] = [];

/** Run one attack. `reject` regex is what a correct rejection should mention. Anything accepted = FAIL. */
type R = Awaited<ReturnType<typeof call>>;
async function attack(id: string, variant: string, expected: string, reject: RegExp, f: () => Promise<R | null> | null, note?: string, inconclusive?: RegExp) {
  if (only && !only.includes(id)) return;
  if (dry) { rows.push({ attack: id, variant, expected, actual: "(dry run, not sent)", verdict: "PLANNED", note }); return; }
  const r = await f();
  if (!r) { rows.push({ attack: id, variant, expected, actual: "n/a", verdict: "SKIPPED", note }); return; }
  const text = r.error ?? r.receiptFailure ?? "";
  const verdict = r.ok ? "FAIL: ATTACK ACCEPTED"
    : reject.test(text) ? "PASS: rejected as expected"
    : inconclusive?.test(text) ? "INCONCLUSIVE: rejected by an earlier check, target check not reached"
    : "PASS?: rejected, different reason";
  rows.push({ attack: id, variant, expected, actual: r.ok ? `accepted, result=${JSON.stringify(r.result)}` : text.slice(0, 300), verdict, tx: r.tx, link: txLink(r.tx), note });
}

console.log(`sale ${sale} status=${info.status} bid_end in ${((bidEnd - chainNow) / 1000).toFixed(0)}s attacker=${attacker}${dry ? " (DRY)" : ""}`);

// 1. forged on_clear
await attack("forged_on_clear", "attacker calls on_clear({nonce}) directly", "Rejected (private callback, only the contract itself)", /private|predecessor|only/i,
  () => call(attacker, sale, "on_clear", { nonce: 1 }, { gas: 50n * TGAS }));

// 2/3. claim attacks need a cleared result
const cleared = !!cs.clearing && ["Cleared", "Settled"].includes(cs.clearing.status) && !info.voided;
let leaves: ReturnType<typeof recompute>["result"]["leaves"] = [], proofs: string[][] = [];
if (cleared) {
  const rc = recompute(cs); leaves = rc.result.leaves;
  const lh = leaves.map(leafHash); proofs = leaves.map((_, i) => merkleProof(lh, i).map(hex));
}
const claimedFlags = cleared ? await Promise.all(leaves.map((l) => view<boolean>(sale, "is_claimed", { account_id: l.bidder }))) : [];
const arg = (i: number, over: Partial<{ tokens: string; refund: string; proof: string[] }> = {}) => ({
  bidder: leaves[i].bidder, index: i, tokens: over.tokens ?? leaves[i].tokens.toString(), refund: over.refund ?? leaves[i].refund.toString(), proof: over.proof ?? proofs[i],
});
const unclaimed = claimedFlags.findIndex((c) => !c);
const claimed = claimedFlags.findIndex((c) => c);

const outsider = [info.params.creator, "deathstalker-sl.testnet", "attack-ghost.testnet"].find((x) => !leaves.some((l) => l.bidder === x))!;
const PROOF = /merkle|proof/i, CLAIMED = /already claimed/i;
const tgt = unclaimed >= 0 ? unclaimed : 0;
const tgtNote = cleared ? (unclaimed >= 0 ? undefined : "every bidder already claimed, so the 'already claimed' check fires before the proof check (INCONCLUSIVE); see the steal variant") : "needs Cleared/Settled sale";
await attack("tampered_claim_proof", "claim with tokens+1 (inflated allocation) and the real proof", "Rejected (invalid merkle proof)", PROOF,
  () => !cleared ? null : call(attacker, sale, "claim", arg(tgt, { tokens: (leaves[tgt].tokens + 1n).toString() }), { gas: 60n * TGAS }), tgtNote, CLAIMED);
await attack("tampered_claim_proof", "claim with refund+1 yocto and the real proof", "Rejected (invalid merkle proof)", PROOF,
  () => !cleared ? null : call(attacker, sale, "claim", arg(tgt, { refund: (leaves[tgt].refund + 1n).toString() }), { gas: 60n * TGAS }), tgtNote, CLAIMED);
await attack("tampered_claim_proof", "claim with an empty proof", "Rejected (invalid merkle proof)", PROOF,
  () => !cleared ? null : call(attacker, sale, "claim", arg(tgt, { proof: [] }), { gas: 60n * TGAS }), tgtNote, CLAIMED);
await attack("tampered_claim_proof", "steal: claim leaf 0's tokens/refund/proof for a non-bidder account name (name swapped)", "Rejected (invalid merkle proof)", PROOF,
  () => !cleared ? null : call(attacker, sale, "claim", { ...arg(0), bidder: outsider }, { gas: 60n * TGAS }), cleared ? "outsider is not in the tree and has not claimed, so the proof check is always reached" : "needs Cleared/Settled sale", CLAIMED);

// 3. double claim
await attack("double_claim", "second claim with the correct proof for an already claimed bidder", "Rejected (already claimed)", /already claimed/i,
  async () => {
    if (!cleared) return null;
    if (claimed >= 0) return call(attacker, sale, "claim", arg(claimed), { gas: 60n * TGAS });
    if (!a["allow-claim"]) return null;
    const first = await call(attacker, sale, "claim", arg(0), { gas: 60n * TGAS });
    rows.push({ attack: "double_claim", variant: "(setup) legitimate first claim", expected: "Accepted", actual: first.ok ? "accepted" : String(first.error), verdict: first.ok ? "SETUP OK" : "SETUP FAILED", tx: first.tx, link: txLink(first.tx) });
    return call(attacker, sale, "claim", arg(0), { gas: 60n * TGAS });
  }, claimed >= 0 ? undefined : a["allow-claim"] ? undefined : "nobody has claimed yet; rerun with --allow-claim to perform one legitimate claim first");

// 4. bid after deadline (junk ciphertext, minimal deposit; rejected calls refund the attached amount)
await attack("bid_after_deadline", "bid() after bid_end", "Rejected (bidding closed)", /clos|ended|deadline|bidding|status|not accepting|late/i,
  () => beforeDeadline ? null : call(attacker, sale, "bid", { ciphertext: "00".repeat(97), commit: "11".repeat(32) }, { gas: 30n * TGAS, deposit: BigInt(info.params.bid_fee) + toYocto("0.01") }),
  beforeDeadline ? "sale is still in its bidding window: variant not applicable" : undefined);

// 5. finalize before deadline (or on a sale that is no longer Bidding)
await attack("finalize_before_deadline", beforeDeadline ? "finalize() while bidding is open" : `finalize() on a sale in status ${info.status}`,
  beforeDeadline ? "Rejected (bid window still open)" : "Rejected (not in Bidding / already finalized)", /deadline|bid_end|open|not .*bidding|status|already|finaliz/i,
  () => call(attacker, sale, "finalize", {}, { gas: (a.gas ? BigInt(String(a.gas)) : 60n) * TGAS, deposit: toYocto("0.1") }));

// 6. refund while not in refund mode
await attack("refund_not_refund_mode", "refund(0) on a non-refund sale", "Rejected (not in refund mode)", /refund/i,
  () => info.refund_mode || info.voided ? null : call(attacker, sale, "refund", { idx: 0 }, { gas: 50n * TGAS }),
  info.refund_mode ? "sale is in refund mode: variant not applicable" : undefined);

// ---------------------------------------------------------------- output
const md = "| attack | variant | expected | actual | verdict | tx |\n|---|---|---|---|---|---|\n" +
  rows.map((r) => `| ${r.attack} | ${r.variant} | ${r.expected} | ${r.actual.replace(/\|/g, "/")} | ${r.verdict} | ${r.link ? `[${r.tx!.slice(0, 8)}](${r.link})` : ""} |`).join("\n");
console.log("\n" + md + "\n");
const outDir = path.join(SCRIPTS_DIR, "evidence"); fs.mkdirSync(outDir, { recursive: true });
if (!dry) {
  fs.writeFileSync(path.join(outDir, `attacks-${sale}.json`), JSON.stringify({ sale, status: info.status, ran_at: new Date().toISOString(), attacker, rows }, null, 1));
  fs.writeFileSync(path.join(outDir, `attacks-${sale}.md`), md + "\n");
  console.log("written", path.join(outDir, `attacks-${sale}.{json,md}`));
}
process.exit(rows.some((r) => r.verdict.startsWith("FAIL")) ? 1 : 0);
