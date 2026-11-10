import { loadDeployments, accessKeyCount, view } from "./chain.ts";
import { fetchSale, recompute, codeHashHex, type ChainSale } from "./sale.ts";
import { hex } from "sealedlaunch-clearing";

export type Level = "PASS" | "FAIL" | "WARN" | "SKIP";
export interface Check { name: string; level: Level; expected?: string; actual?: string; note?: string }
export interface VerifyReport {
  sale: string; status: string; pass: boolean; checks: Check[];
  summary: Record<string, string | number>;
  bidders: { bidder: string; tokens: string; refund: string; cost: string; proofOk: boolean }[];
}

export async function verifySale(sale: string, preloaded?: ChainSale): Promise<VerifyReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, expected: unknown, actual: unknown, note?: string, failLevel: Level = "FAIL") =>
    checks.push({ name, level: ok ? "PASS" : failLevel, expected: String(expected), actual: String(actual), note });

  const cs = preloaded ?? (await fetchSale(sale));
  const { info, slots, clearing } = cs;
  const p = info.params;

  // 1. keyless
  const keys = await accessKeyCount(sale);
  add("sale account has 0 access keys", keys === 0, 0, keys);

  // 2. code hash
  const ch = await codeHashHex(sale);
  const d = loadDeployments();
  const known = Object.values(d.sales).find((s) => s.account === sale)?.sale_wasm_sha256 as string | undefined;
  let factoryHash: string | null = null;
  try { factoryHash = await view<string>(d.factory.account, "get_sale_code_hash"); } catch { /* ignore */ }
  if (known) add("sale wasm sha256 == hash recorded in deployments.json", ch === known, known, ch);
  if (factoryHash) add("sale wasm sha256 == factory's current embedded sale wasm", ch === factoryHash, factoryHash, ch,
    "older sales deployed before a sale-wasm fix legitimately differ", "WARN");
  add("sale lives under the factory account", sale.endsWith("." + d.factory.account), `*.${d.factory.account}`, sale, undefined, "WARN");
  add("sale.params.factory == factory in deployments.json", p.factory === d.factory.account, d.factory.account, p.factory);

  // 3. slot-level sanity
  add("bid_count == number of slots read", slots.length === info.bid_count, info.bid_count, slots.length);
  const slotDeposits = slots.reduce((a, s) => a + BigInt(s.deposit), 0n);
  add("sum(slot deposits) == get_deposits_total", slotDeposits === BigInt(info.deposits_total), info.deposits_total, slotDeposits);
  const fees = BigInt(p.bid_fee) * BigInt(info.bid_count);
  add("fees_accrued == bid_count * bid_fee (+ any bonds/slashes)", BigInt(info.fees_accrued) === fees, fees, info.fees_accrued,
    "can differ legitimately after cancel/slash flows", "WARN");

  const summary: Record<string, string | number> = {
    bids: info.bid_count, status: info.status, mode: info.mode, lp_status: info.lp_status,
    deposits_total: info.deposits_total, fees_accrued: info.fees_accrued,
  };
  let bidders: VerifyReport["bidders"] = [];

  const cleared = clearing && ["Cleared", "Settled", "Challenge"].includes(clearing.status) && !info.voided;
  if (!cleared) {
    checks.push({ name: "clearing recompute", level: "SKIP", note: `status ${info.status}, voided=${info.voided}, clearing=${clearing ? clearing.status : "none"}` });
    if (info.refund_mode || info.status === "Refund")
      checks.push({ name: "refund mode: no clearing result expected", level: "PASS", note: "use refund(idx)/refund_all; full deposits returned" });
  } else {
    // 4. recompute
    const rc = recompute(cs);
    const r = rc.result;
    add("P* recomputed == on-chain p_star", r.pStar.toString() === clearing.p_star, clearing.p_star, r.pStar);
    add("alloc_root recomputed == on-chain", hex(r.allocRoot) === clearing.alloc_root, clearing.alloc_root, hex(r.allocRoot));
    add("leaf_count recomputed == on-chain", r.leaves.length === clearing.leaf_count, clearing.leaf_count, r.leaves.length);
    add("input_hash recomputed == on-chain", hex(r.inputHash) === clearing.input_hash, clearing.input_hash, hex(r.inputHash));
    add("sold recomputed == on-chain", r.sold.toString() === clearing.sold, clearing.sold, r.sold);
    add("burned recomputed == on-chain", r.burned.toString() === clearing.burned, clearing.burned, r.burned);
    add("raise recomputed == on-chain", r.raise.toString() === clearing.raise, clearing.raise, r.raise);
    add("sold + burned == auction_supply", r.sold + r.burned === BigInt(p.auction_supply), p.auction_supply, r.sold + r.burned);
    add("P* >= reserve_price", r.pStar >= BigInt(p.reserve_price), `>= ${p.reserve_price}`, r.pStar);
    add("on-chain recompute flag (verified_onchain)", clearing.verified_onchain, true, clearing.verified_onchain,
      "false = result accepted above recompute cap / via challenge window", "WARN");

    // uniform price: every filled bid bid >= P*, and each bidder paid exactly ceil(P* * tokens)
    let uniform = true; let filledCount = 0;
    r.outcomes.forEach((o, i) => {
      if ("filled" in o && o.filled > 0n) {
        filledCount++;
        const pl = cs.revealed[i];
        if (!pl || BigInt(pl.price) < r.pStar) uniform = false;
      }
    });
    add("every filled bid offered >= P* (uniform price)", uniform, true, uniform, `${filledCount} filled slots`);
    add("every leaf Merkle proof verifies against alloc_root", rc.perBidder.every((b) => b.proofOk), true,
      rc.perBidder.every((b) => b.proofOk));

    // 5. conservation, exact
    let costSum = 0n; for (const b of rc.perBidder) costSum += b.cost;
    add("per-bidder: refund == deposit - ceil(P* * tokens)", rc.perBidder.every((b) => b.refund === b.deposit - b.cost), true,
      rc.perBidder.every((b) => b.refund === b.deposit - b.cost));
    add("sum(per-bidder cost) == raise", costSum === r.raise, r.raise, costSum);
    add("CONSERVATION: sum(deposits) == raise + sum(refunds)", rc.sumDeposits === r.raise + rc.sumRefunds,
      rc.sumDeposits, r.raise + rc.sumRefunds, "deposits are net of bid fees");
    const gross = rc.sumDeposits + fees; // everything bidders attached: net deposits + bid_count * bid_fee
    const out = r.raise + rc.sumRefunds + BigInt(info.fees_accrued);
    add("CONSERVATION incl. fees: sum(deposits)+n*fee == raise + sum(refunds) + fees_accrued", gross === out, gross, out);
    bidders = rc.perBidder.map((b) => ({ bidder: b.bidder, tokens: b.tokens.toString(), refund: b.refund.toString(), cost: b.cost.toString(), proofOk: b.proofOk }));
    Object.assign(summary, {
      p_star: r.pStar.toString(), sold: r.sold.toString(), raise: r.raise.toString(), burned: r.burned.toString(),
      alloc_root: hex(r.allocRoot), leaf_count: r.leaves.length, input_hash: hex(r.inputHash),
      sum_refunds: rc.sumRefunds.toString(), sum_deposits: rc.sumDeposits.toString(),
      fill_rate_pct: Number((r.sold * 10000n) / BigInt(p.auction_supply)) / 100,
    });
  }
  const pass = !checks.some((c) => c.level === "FAIL");
  return { sale, status: info.status, pass, checks, summary, bidders };
}

export function printReport(rep: VerifyReport): void {
  const w = Math.max(...rep.checks.map((c) => c.name.length));
  console.log(`\nSealedLaunch verify: ${rep.sale}   status=${rep.status}\n`);
  for (const c of rep.checks) {
    const tail = c.level === "PASS" ? "" : c.level === "SKIP" ? (c.note ?? "") : `expected ${c.expected} got ${c.actual}${c.note ? " (" + c.note + ")" : ""}`;
    console.log(`  ${c.level.padEnd(4)}  ${c.name.padEnd(w)}  ${tail}`);
  }
  if (rep.bidders.length) {
    console.log("\n  per bidder (yocto / base units):");
    for (const b of rep.bidders) console.log(`    ${b.bidder.padEnd(34)} tokens=${b.tokens} cost=${b.cost} refund=${b.refund} proof=${b.proofOk ? "ok" : "BAD"}`);
  }
  console.log("\n  summary:", JSON.stringify(rep.summary));
  const n = (l: Level) => rep.checks.filter((c) => c.level === l).length;
  console.log(`\n  RESULT: ${rep.pass ? "PASS" : "FAIL"}  (${n("PASS")} pass, ${n("FAIL")} fail, ${n("WARN")} warn, ${n("SKIP")} skip)\n`);
}
