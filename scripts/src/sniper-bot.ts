#!/usr/bin/env tsx
// Sniper simulation (SEALED_LAUNCH section 9). Testnet + our factory only.
//
//  submit:  pnpm sniper-bot --testnet --sale <acct|alias> --scenario first|last|split --n 50 \
//             (--accounts a.testnet,b.testnet | --create-accounts K) [--dry] [--out file.json]
//  analyse: pnpm sniper-bot --testnet --collect file.json     (after the sale is cleared)
import fs from "node:fs";
import {
  parseArgs, requireTestnet, assertChainTestnet, resolveSale, die, nowChainMs, sleep, toYocto, near, balanceOf, loadDeployments, view, txLink, SCRIPTS_DIR,
} from "./lib/chain.ts";
import { fetchSale, recompute, pmap } from "./lib/sale.ts";
import { assertOurSale, getPubkey, prepareBid, sendBid, createFaucetAccount, type BidRecord } from "./lib/bids.ts";
import { cost } from "sealedlaunch-clearing";
import path from "node:path";

const a = parseArgs(process.argv.slice(2));
requireTestnet(a as any);
await assertChainTestnet();

const rank = (xs: number[]) => {
  const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
  return r as number[];
};
const pearson = (x: number[], y: number[]) => {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};

// ---------------------------------------------------------------------- collect
if (a.collect) {
  const f = String(a.collect);
  const res = JSON.parse(fs.readFileSync(f, "utf8"));
  const cs = await fetchSale(res.sale);
  assertOurSale(res.sale, cs.info);
  if (!cs.clearing) die(`sale ${res.sale} not cleared yet (status ${cs.info.status})`);
  const rc = recompute(cs); const D = cs.info.params.token_decimals; const pStar = rc.result.pStar;
  const byCommit = new Map(cs.slots.map((s, i) => [s.commit, i]));
  const mine = new Set<number>();
  for (const b of res.bids as BidRecord[] & any[]) {
    const i = byCommit.get(b.commit);
    if (i === undefined) { b.outcome = "not-on-chain"; continue; }
    mine.add(i); b.slot = i;
    const o = rc.outcomes[i];
    const filled = "filled" in o ? o.filled : 0n;
    b.dropped = "dropped" in o ? o.dropped : null;
    b.tokens_filled = filled.toString();
    b.fill_ratio = Number((filled * 10000n) / BigInt(b.size)) / 10000;
    b.price_paid_per_token = filled > 0n ? pStar.toString() : null;
    b.cost_paid = filled > 0n ? (cost(pStar, filled, D) ?? 0n).toString() : "0";
    b.bid_price_over_pstar = Number((BigInt(b.price) * 10000n) / pStar) / 10000;
  }
  const sum = (xs: bigint[]) => xs.reduce((s, v) => s + v, 0n);
  const botFilled = (res.bids as any[]).filter((b) => b.tokens_filled && BigInt(b.tokens_filled) > 0n);
  const botTokens = sum(botFilled.map((b) => BigInt(b.tokens_filled)));
  const botCost = sum(botFilled.map((b) => BigInt(b.cost_paid)));
  // honest = every other valid slot
  let honTokens = 0n, honCost = 0n, honWinners = 0;
  cs.slots.forEach((_, i) => { if (mine.has(i)) return; const o = rc.outcomes[i]; if ("filled" in o && o.filled > 0n) { honTokens += o.filled; honCost += cost(pStar, o.filled, D) ?? 0n; honWinners++; } });
  const avg = (c: bigint, t: bigint) => (t === 0n ? null : (c * 10n ** BigInt(D)) / t);
  // timing vs outcome among bot bids that were valid (price >= P* or not), correlation of arrival with fill ratio
  const timed = (res.bids as any[]).filter((b) => b.fill_ratio !== undefined && (b.block_ts_ms ?? b.submit_ms));
  const corr = pearson(rank(timed.map((b) => b.block_ts_ms ?? b.submit_ms)), rank(timed.map((b) => b.fill_ratio)));
  const corrSlot = pearson(rank(timed.map((b) => b.slot)), rank(timed.map((b) => b.fill_ratio)));
  // conditional on equal bid price band this is only meaningful when prices are equal; report both
  const everyWinnerPaidPStar = botFilled.every((b) => BigInt(b.cost_paid) === (cost(pStar, BigInt(b.tokens_filled), D) ?? -1n));
  res.analysis = {
    analysed_at: new Date().toISOString(), p_star: pStar.toString(), sale_status: cs.info.status,
    bot_bids: res.bids.length, bot_winning_bids: botFilled.length, bot_tokens: botTokens.toString(),
    bot_avg_price_paid: avg(botCost, botTokens)?.toString() ?? null,
    honest_winning_slots: honWinners, honest_tokens: honTokens.toString(), honest_avg_price_paid: avg(honCost, honTokens)?.toString() ?? null,
    every_bot_winner_paid_p_star: everyWinnerPaidPStar,
    spearman_arrival_time_vs_fill_ratio: corr, spearman_slot_index_vs_fill_ratio: corrSlot,
    note: "price paid per whole token is identical (P*) for every winner by construction; correlation near 0 means arrival time does not predict outcome. With few distinct bid prices the correlation is confounded by price, so also compare fill ratio at equal bid price.",
  };
  fs.writeFileSync(f, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res.analysis, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------- submit
const d = loadDeployments();
const sale = resolveSale(String(a.sale ?? die("--sale required")), d);
const scenario = String(a.scenario ?? die("--scenario first|last|split required"));
if (!["first", "last", "split"].includes(scenario)) die("scenario must be first|last|split");
const n = Number(a.n ?? 10);
const dry = !!a.dry;
if (!sale.endsWith("." + d.factory.account)) die(`refusing: ${sale} is not a sub-account of factory ${d.factory.account}`);
const info = (await fetchSale(sale).catch((e) => die(`not a readable sale: ${sale} (${String(e.message).slice(0, 120)})`))).info;
assertOurSale(sale, info);
const P = info.params;
const bidEnd = Number(P.bid_end_ms);
const reserve = BigInt(P.reserve_price);
const unit = 10n ** BigInt(P.token_decimals);
const pMin = a["price-min"] ? toYocto(String(a["price-min"])) : reserve;
const pMax = a["price-max"] ? toYocto(String(a["price-max"])) : reserve * 2n;
const sizeTok = BigInt(String(a.size ?? 10));
const minSize = BigInt(P.min_size);
const tag = String(a.tag ?? Date.now().toString(36));

let accounts: string[] = a.accounts ? String(a.accounts).split(",") : [];
if (a["create-accounts"]) {
  const k = Number(a["create-accounts"]);
  for (let i = 0; i < k; i++) accounts.push(`dsl-bot-${tag}-${i}.testnet`);
}
if (!accounts.length) die("need --accounts a,b,c or --create-accounts K");

const rnd = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(Math.random() * 1e9)) * (hi - lo)) / 1_000_000_000n;
const plans = Array.from({ length: n }, (_, i) => {
  const account = accounts[i % accounts.length];
  if (scenario === "split") {
    const total = BigInt(String(a["total-size"] ?? 500)) * unit;
    const price = a.price ? toYocto(String(a.price)) : rnd(pMin, pMax);
    const size = total / BigInt(n);
    return { account, price, size: size < minSize ? minSize : size };
  }
  return { account, price: rnd(pMin, pMax), size: sizeTok * unit };
});

let locked = 0n; for (const p of plans) locked += (cost(p.price, p.size, P.token_decimals) ?? 0n) + BigInt(P.bid_fee);
const burnedFees = BigInt(P.bid_fee) * BigInt(n);
console.log(`sale ${sale} status=${info.status} bid_end=${new Date(bidEnd).toISOString()} (in ${((bidEnd - Date.now()) / 1000).toFixed(0)}s)`);
console.log(`scenario=${scenario} n=${n} accounts=${accounts.length} locked=${near(locked)} NEAR (refunded after clear except fees ${near(burnedFees)} NEAR + gas)`);
if (dry) console.log("DRY RUN: building+encrypting bids locally, nothing is sent.");

if (!dry && info.status !== "Bidding") die(`sale not in Bidding (${info.status})`);
const pk = await getPubkey(sale);

if (!dry) {
  if (a["create-accounts"]) {
    console.log(`creating ${accounts.length} faucet accounts...`);
    await pmap(accounts, 4, createFaucetAccount);
  }
  // pre-flight balances
  const need = new Map<string, bigint>();
  for (const p of plans) need.set(p.account, (need.get(p.account) ?? 0n) + (cost(p.price, p.size, P.token_decimals) ?? 0n) + BigInt(P.bid_fee) + toYocto("0.01"));
  for (const [acc, nd] of need) { const b = await balanceOf(acc); if (b < nd) die(`${acc} has ${near(b)} NEAR, needs ~${near(nd)}`); }
}

const prepared = plans.map((p) => prepareBid(sale, pk, info, p));
if (dry) {
  console.log(`prepared ${prepared.length} bids; first: ${JSON.stringify({ ...prepared[0].rec, salt: "<hidden>" })}`);
  const out = path.join(SCRIPTS_DIR, "out"); fs.mkdirSync(out, { recursive: true });
  const f = String(a.out ?? path.join(out, `sniper-dry-${scenario}.json`));
  fs.writeFileSync(f, JSON.stringify({ dry: true, sale, scenario, n, plan: prepared.map((x) => ({ ...x.rec, salt: undefined })) }, null, 1));
  console.log("dry plan written to", f);
  process.exit(0);
}

// group by account, per-account sequential, accounts parallel
const byAcc = new Map<string, typeof prepared>();
for (const p of prepared) (byAcc.get(p.rec.account) ?? byAcc.set(p.rec.account, []).get(p.rec.account)!).push(p);

const skew = (await nowChainMs()) - Date.now(); // chain clock - local clock
const jitter = Number(a.spread ?? 0);
if (scenario === "last") {
  const lead = Number(a["lead-ms"] ?? 5000);
  const fireAt = bidEnd - lead - skew;
  console.log(`waiting until bid_end - ${lead}ms (${((fireAt - Date.now()) / 1000).toFixed(1)}s)...`);
  while (Date.now() < fireAt) await sleep(Math.min(250, fireAt - Date.now()));
}
console.log("FIRE");
const started = Date.now();
const results: BidRecord[] = [];
await Promise.all([...byAcc.values()].map(async (list) => {
  if (scenario === "split" && jitter) await sleep(Math.random() * jitter);
  for (const p of list) results.push(await sendBid(sale, p, bidEnd));
}));
results.sort((x, y) => (x.submit_ms ?? 0) - (y.submit_ms ?? 0));
const okN = results.filter((r) => r.ok).length;
console.log(`done: ${okN}/${results.length} accepted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const r of results.slice(0, 5)) console.log(" ", r.account, r.ok ? "ok" : "FAIL " + r.error, txLink(r.tx));
const outdir = path.join(SCRIPTS_DIR, "out"); fs.mkdirSync(outdir, { recursive: true });
const f = String(a.out ?? path.join(outdir, `sniper-${scenario}-${tag}.json`));
fs.writeFileSync(f, JSON.stringify({ sale, scenario, n, started_ms: started, chain_clock_skew_ms: skew, bid_end_ms: bidEnd, bids: results }, null, 1));
console.log("results written to", f, "\nafter clearing run: pnpm sniper-bot --testnet --collect", f);
