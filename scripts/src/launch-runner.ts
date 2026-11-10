#!/usr/bin/env tsx
// End-to-end launch on testnet with house bidders; writes evidence/<sale>.json + a markdown row.
//
//   pnpm launch-runner --testnet --dry [--bids 20]                  # no spending, plans + local clearing simulation
//   pnpm launch-runner --testnet --name run1 --bids 20 --window 150 # REAL: ~5 NEAR creation deposit + bids + gas
//
// Flags: --creator <acct> (default deathstalker-sl-3.testnet), --bidders a,b,c (default dsl-bidder1..3),
//        --reserve <NEAR/token> (0.002), --supply <tokens> (1000), --oversub <x> (1.5), --curve linear|exp|pareto,
//        --window <secs> (150), --max-bids <n> (default max(100,bids+10)), --hold-claims <secs> (pause before claims), --lp-bps (5000), --from <sale|alias> (skip create+bid, run finalize..verify on existing sale)
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  parseArgs, requireTestnet, assertChainTestnet, die, loadDeployments, view, call, sleep, nowChainMs, txLink, toYocto, near, balanceOf, resolveSale,
  txInfo, gasBurnt, blockTimeMs, SCRIPTS_DIR, TGAS, type CallResult,
} from "./lib/chain.ts";
import { fetchSale, recompute, type ChainSale } from "./lib/sale.ts";
import { assertOurSale, getPubkey, prepareBid, sendBid, type BidRecord, type BidPlan } from "./lib/bids.ts";
import { verifySale, printReport } from "./lib/verify-core.ts";
import { clear, cost, paramsFromWire, entryFromWire, unhex, leafHash, merkleProof, hex } from "sealedlaunch-clearing";

const a = parseArgs(process.argv.slice(2));
requireTestnet(a as any);
await assertChainTestnet();
const dry = !!a.dry;
const d = loadDeployments();
const FACTORY = d.factory.account;
const creator = String(a.creator ?? "deathstalker-sl-3.testnet");
const bidders = String(a.bidders ?? "dsl-bidder1.testnet,dsl-bidder2.testnet,dsl-bidder3.testnet").split(",");
const nBids = Number(a.bids ?? 20);
const D = 18; const unit = 10n ** BigInt(D);
const reserve = toYocto(String(a.reserve ?? "0.002"));
const supplyTok = BigInt(String(a.supply ?? 1000));
const oversub = Number(a.oversub ?? 1.5);
const curve = String(a.curve ?? "pareto");
const windowSecs = Number(a.window ?? 150);
const lpBps = Number(a["lp-bps"] ?? 5000);
const tag = String(a.name ?? `ln${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]/g, "");

const log = (...x: unknown[]) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...x);
const T0 = Date.now();
const steps: any[] = [];
let totalGas = 0n;
const step = (name: string, r: CallResult, extra: object = {}) => {
  if (r.gasBurnt) totalGas += r.gasBurnt;
  steps.push({ name, ok: r.ok, tx: r.tx, link: txLink(r.tx), gas_burnt: r.gasBurnt?.toString(), error: r.error ?? r.receiptFailure, at: new Date().toISOString(), ...extra });
  log(name, r.ok ? "ok" : `FAIL ${r.error ?? r.receiptFailure}`, txLink(r.tx));
};

// ----------------------------------------------------------------- plans
function curvePrice(u: number): bigint {
  const x = curve === "linear" ? 1 + 4 * u : curve === "exp" ? 1 + 8 * u * u : Math.min(10, 1 / Math.pow(1 - u * 0.97, 1 / 1.5));
  return (reserve * BigInt(Math.round(x * 1e6))) / 1_000_000n;
}
function planBids(): BidPlan[] {
  const meanSize = (Number(supplyTok) * oversub) / nBids;
  const plans: BidPlan[] = [];
  for (let i = 0; i < nBids; i++) {
    const u = (i + 0.5) / nBids;
    const sz = Math.max(1, Math.round(meanSize * (0.4 + Math.random() * 1.2)));
    let price = curvePrice(u);
    if (i === nBids - 1 && nBids >= 5) price = reserve / 2n; // one deliberately below reserve: must be dropped
    plans.push({ account: bidders[i % bidders.length], price, size: BigInt(sz) * unit });
  }
  for (let i = plans.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [plans[i], plans[j]] = [plans[j], plans[i]]; }
  return plans;
}

function createParams(bidEndMs: number) {
  return {
    name: tag, symbol: tag.slice(0, 8).toUpperCase(), token_name: `SealedLaunch ${tag}`, icon: null, token_decimals: D,
    auction_supply: (supplyTok * unit).toString(), lp_token_reserve: ((supplyTok * unit * BigInt(lpBps)) / 10000n + unit).toString(),
    creator_supply: (supplyTok * unit / 10n).toString(), reserve_price: reserve.toString(), min_size: unit.toString(),
    bid_fee: toYocto("0.001").toString(), payment_token: null, bid_end_ms: bidEndMs.toString(), challenge_secs: 30, lp_bps: lpBps,
    vesting_secs: 600, outlayer_project: d.outlayer.project, code_hash: d.outlayer.worker_wasm_sha256, max_bids: Number(a["max-bids"] ?? Math.max(100, nBids + 10)),
  };
}

// Local simulation of what the contract should compute (also used as the dry-run result).
function simulate(sale: string, p: ReturnType<typeof createParams>, plans: BidPlan[]) {
  const recs = plans.map((pl) => {
    const salt = new Uint8Array(randomBytes(32));
    const c = cost(pl.price, pl.size, D)!;
    return { pl, salt, deposit: c };
  });
  const entries = recs.map((r, i) => ({
    bidder: r.pl.account, commit: hex(new Uint8Array(32)), deposit: r.deposit.toString(),
    plaintext: { price: r.pl.price.toString(), size: r.pl.size.toString(), salt: hex(r.salt) },
  }));
  // commits must match for validity: compute real ones
  return (async () => {
    const { commitHash } = await import("sealedlaunch-clearing");
    entries.forEach((e, i) => { e.commit = hex(commitHash({ price: recs[i].pl.price, size: recs[i].pl.size, salt: recs[i].salt }, e.bidder, sale)); });
    const r = clear(paramsFromWire({ sale_id: sale, supply: p.auction_supply, reserve: p.reserve_price, token_decimals: D, min_size: p.min_size }), entries.map(entryFromWire));
    return r;
  })();
}

function economics(supply: bigint, reservePool: bigint, pStar: bigint, raise: bigint, burned: bigint, bps: number) {
  const lpFunds = (raise * BigInt(bps)) / 10000n;
  let lpTokens = pStar === 0n ? 0n : (lpFunds * unit) / pStar;
  if (lpTokens > reservePool) lpTokens = reservePool;
  return { lp_funds: lpFunds, lp_tokens: lpTokens, burn_total: burned + (reservePool - lpTokens) };
}

// ----------------------------------------------------------------- DRY RUN
if (dry) {
  const plans = planBids();
  const saleId = `sale-${tag}.${FACTORY}`;
  const p = createParams(Date.now() + windowSecs * 1000);
  const need = await view<string>(FACTORY, "get_required_deposit");
  const r = await simulate(saleId, p, plans);
  const lockByAcc = new Map<string, bigint>();
  for (const pl of plans) lockByAcc.set(pl.account, (lockByAcc.get(pl.account) ?? 0n) + cost(pl.price, pl.size, D)! + BigInt(p.bid_fee));
  const econ = economics(BigInt(p.auction_supply), BigInt(p.lp_token_reserve), r.pStar, r.raise, r.burned, lpBps);
  console.log(`DRY RUN (nothing sent). sale would be ${saleId}, creator ${creator}`);
  console.log(`create_sale deposit: ${near(BigInt(need))} NEAR (from get_required_deposit), 300 Tgas, window ${windowSecs}s`);
  console.log("create params:", JSON.stringify(p));
  console.log(`bids: ${plans.length} across ${bidders.length} bidders, curve=${curve}, oversub=${oversub}`);
  for (const [acc, v] of lockByAcc) console.log(`  ${acc} must hold >= ${near(v + toYocto("0.05"))} NEAR (locked ${near(v)} incl. fees, refunded after clear)`);
  console.log(`creator ${creator} needs >= ${near(BigInt(need) + toYocto("0.5"))} NEAR (deposit + finalize 0.1 + gas)`);
  for (const acc of [creator, ...bidders]) console.log(`  balance ${acc}: ${near(await balanceOf(acc).catch(() => 0n))} NEAR`);
  const dropped = r.outcomes.filter((o) => "dropped" in o).length;
  console.log(`LOCAL SIMULATION: P*=${near(r.pStar)} NEAR/token, sold=${Number(r.sold / unit)} of ${supplyTok}, fill=${Number((r.sold * 10000n) / (supplyTok * unit)) / 100}%, raise=${near(r.raise)} NEAR, burned=${Number(r.burned / unit)}, dropped=${dropped}`);
  console.log(`  LP: ${near(econ.lp_funds)} NEAR + ${Number(econ.lp_tokens / unit)} tokens; burn total ${Number(econ.burn_total / unit)} tokens`);
  // exercise encryption path against a real pk
  const beta = await fetchSale(resolveSale("beta", d));
  const prep = prepareBid(beta.sale, await getPubkey(beta.sale), beta.info, plans[0]);
  console.log(`encrypt check against sale-beta pk: ciphertext ${prep.rec.ciphertext_len} B, commit ${prep.rec.commit.slice(0, 16)}...`);
  const outdir = path.join(SCRIPTS_DIR, "out"); fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(path.join(outdir, `launch-dry-${tag}.json`), JSON.stringify({ params: p, plans: plans.map((x) => ({ ...x, price: x.price.toString(), size: x.size.toString() })), sim: { p_star: r.pStar.toString(), raise: r.raise.toString(), sold: r.sold.toString(), burned: r.burned.toString() } }, null, 1));
  process.exit(0);
}

// ----------------------------------------------------------------- REAL RUN
const waitFor = async <T,>(what: string, f: () => Promise<T | null | false>, timeoutMs: number, everyMs = 2000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await f(); if (v) return v as T; if (Date.now() > end) die(`timeout waiting for ${what}`, 3); await sleep(everyMs); }
};

let sale: string; let bidRecs: BidRecord[] = []; let createdAtMs = Date.now();
const creatorBal0 = await balanceOf(creator);
let bidEndMs: number;

if (a.from) {
  sale = resolveSale(String(a.from), d);
  const cs0 = await fetchSale(sale); assertOurSale(sale, cs0.info);
  bidEndMs = Number(cs0.info.params.bid_end_ms);
  log("resuming existing sale", sale, cs0.info.status);
} else {
  bidEndMs = (await nowChainMs()) + windowSecs * 1000;
  const p = createParams(bidEndMs);
  const need = BigInt(await view<string>(FACTORY, "get_required_deposit"));
  if (creatorBal0 < need + toYocto("0.6")) die(`${creator} has ${near(creatorBal0)} NEAR; needs > ${near(need + toYocto("0.6"))}`);
  const r = await call(creator, FACTORY, "create_sale", { p }, { gas: 300n * TGAS, deposit: need });
  step("create_sale", r);
  if (!r.ok) die("create_sale failed");
  sale = `sale-${tag}.${FACTORY}`;
  createdAtMs = Date.now();
  const cs0 = await waitFor("sale Ready", async () => { try { const c = await fetchSale(sale); const pk = await view<string | null>(sale, "get_pubkey"); return pk ? c : null; } catch { return null; } }, 90_000);
  assertOurSale(sale, cs0.info);
  const pk = await getPubkey(sale);
  const plans = planBids();
  const prepared = plans.map((pl) => prepareBid(sale, pk, cs0.info, pl));
  const byAcc = new Map<string, typeof prepared>();
  for (const x of prepared) (byAcc.get(x.rec.account) ?? byAcc.set(x.rec.account, []).get(x.rec.account)!).push(x);
  log(`placing ${prepared.length} bids (window ends in ${((bidEndMs - (await nowChainMs())) / 1000).toFixed(0)}s)`);
  await Promise.all([...byAcc.values()].map(async (list) => { for (const x of list) bidRecs.push(await sendBid(sale, x, bidEndMs)); }));
  const okBids = bidRecs.filter((b) => b.ok).length;
  for (const b of bidRecs) totalGas += BigInt(b.gas_burnt ?? 0);
  steps.push({ name: "bids", ok: okBids === bidRecs.length, accepted: okBids, total: bidRecs.length, txs: bidRecs.map((b) => b.tx) });
  log(`bids accepted ${okBids}/${bidRecs.length}`);
}

// wait for deadline, finalize
await waitFor("bid_end", async () => ((await nowChainMs()) > bidEndMs + 1500 ? true : null), 600_000, 1500);
const preFin = await fetchSale(sale);
const gasNeeded = BigInt(await view<string>(sale, "finalize_gas_needed").catch(() => (240n * TGAS).toString()));
const finGas = gasNeeded + 20n * TGAS > 300n * TGAS ? 300n * TGAS : gasNeeded + 20n * TGAS;
const balBeforeFin = await balanceOf(creator);
const finRes = await call(creator, sale, "finalize", {}, { gas: finGas, deposit: toYocto("0.1") });
step("finalize", finRes, { gas_prepaid: finGas.toString() });
if (!finRes.ok) die("finalize failed");
const finBlockMs = finRes.blockHash ? await blockTimeMs(finRes.blockHash) : Date.now();
const finWall = Date.now();
const cleared = await waitFor("clearing", async () => {
  const s = (await view<any>(sale, "get_sale"));
  return ["Cleared", "Challenge", "Settled"].includes(s.status) ? s : s.status === "Refund" ? s : null;
}, 400_000);
const onClearWall = Date.now();
const onClearChainMs = Number(BigInt(cleared.cleared_at_ns) / 1_000_000n);
log("status after finalize:", cleared.status);
if (cleared.status === "Refund") die("sale went to Refund mode; evidence will show refund path only");

// outlayer net cost = creator balance change across finalize minus own gas (refund may lag; measured after clear)
await sleep(3000);
const balAfterFin = await balanceOf(creator);
const gasPrice = 100_000_000n; // yocto per gas, testnet minimum
const outlayerCost = balBeforeFin - balAfterFin - (finRes.gasBurnt ?? 0n) * gasPrice;

if (cleared.status === "Challenge") {
  const until = Number(BigInt(cleared.challenge_end_ns) / 1_000_000n);
  log("waiting for challenge window");
  await waitFor("challenge end", async () => ((await nowChainMs()) > until + 1500 ? true : null), 120_000, 2000);
}

// optional pause so attack-suite / snipers can probe the Cleared-but-unclaimed state
if (a["hold-claims"]) { log(`holding claims for ${a["hold-claims"]}s (evidence hook)`); await sleep(Number(a["hold-claims"]) * 1000); }
// claims
const cs = await fetchSale(sale);
const rc = recompute(cs);
const lh = rc.result.leaves.map(leafHash);
let claimOk = 0;
for (let i = 0; i < rc.result.leaves.length; i++) {
  const l = rc.result.leaves[i];
  const proof = merkleProof(lh, i).map(hex);
  const r = await call(creator, sale, "claim", { bidder: l.bidder, index: i, tokens: l.tokens.toString(), refund: l.refund.toString(), proof }, { gas: 60n * TGAS });
  step(`claim ${l.bidder}`, r); if (r.ok) claimOk++;
}
const st = await call(creator, sale, "settle", {}, { gas: 300n * TGAS });
step("settle", st);
const afterSettle = await waitFor("lp done", async () => { const s = await view<any>(sale, "get_sale"); return s.lp_status === "Done" || s.lp_status === "Failed" ? s : null; }, 150_000, 3000).catch(() => view<any>(sale, "get_sale"));

// verify + evidence
const rep = await verifySale(sale);
printReport(rep);
const info = (await fetchSale(sale)).info;
const r = rc.result;
const econ = economics(r.supply, BigInt(info.params.lp_token_reserve), r.pStar, r.raise, r.burned, info.params.lp_bps);
const finToClearS = (onClearChainMs - finBlockMs) / 1000;
const gasCost = totalGas * gasPrice;
const row = {
  sale, bids: info.bid_count, p_star_near: near(r.pStar), fill_rate_pct: Number((r.sold * 10000n) / r.supply) / 100,
  raise_near: near(r.raise), lp_funds_near: near(econ.lp_funds), lp_tokens: (econ.lp_tokens / unit).toString(),
  burn_tokens: (econ.burn_total / unit).toString(), finalize_to_on_clear_s: finToClearS, finalize_to_on_clear_wall_s: (onClearWall - finWall) / 1000,
  gas_total_tgas: Number(totalGas / 10n ** 9n) / 1000, gas_cost_near: near(gasCost), outlayer_net_cost_near: near(outlayerCost),
  creation_deposit_near: near(BigInt(await view<string>(FACTORY, "get_required_deposit"))), verify_pass: rep.pass,
};
const evDir = path.join(SCRIPTS_DIR, "evidence"); fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, `${sale}.json`), JSON.stringify({
  sale, factory: FACTORY, created_at_ms: createdAtMs, bid_end_ms: bidEndMs, params: info.params, row, steps, bids: bidRecs,
  clearing: cs.clearing, lp_status: afterSettle.lp_status, claims_ok: claimOk, verify: rep,
}, null, 1));
const header = "| sale | bids | P* (NEAR/token) | fill % | raise (NEAR) | LP funds / tokens | burn (tokens) | finalize->on_clear (s) | gas (Tgas) / cost (NEAR) | OutLayer net (NEAR) | verify |\n|---|---|---|---|---|---|---|---|---|---|---|\n";
const md = `| ${sale} | ${row.bids} | ${row.p_star_near} | ${row.fill_rate_pct} | ${row.raise_near} | ${row.lp_funds_near} / ${row.lp_tokens} | ${row.burn_tokens} | ${row.finalize_to_on_clear_s} | ${row.gas_total_tgas} / ${row.gas_cost_near} | ${row.outlayer_net_cost_near} | ${rep.pass ? "PASS" : "FAIL"} |\n`;
const tbl = path.join(evDir, "TABLE.md");
if (!fs.existsSync(tbl)) fs.writeFileSync(tbl, header);
fs.appendFileSync(tbl, md);
console.log("\n" + header + md);
console.log("evidence:", path.join(evDir, `${sale}.json`));
process.exit(rep.pass ? 0 : 1);
