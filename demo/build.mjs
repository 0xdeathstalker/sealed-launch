// Build demo/index.html: bundle clearing-js with esbuild, inject real evidence parsed from TABLE.md + deployments.json.
// Usage: node demo/build.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const req = createRequire(resolve(root, "clearing-js/package.json"));
const esbuild = (() => { try { return req("esbuild"); } catch { return createRequire(resolve(root, "clearing-js/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/"))("esbuild"); } })();

const out = await esbuild.build({
  entryPoints: [resolve(here, "src/entry.ts")], bundle: true, minify: true, write: false, format: "iife",
  platform: "browser", target: "es2020", legalComments: "none",
  nodePaths: [resolve(root, "clearing-js/node_modules")],
  define: { "process.env.NODE_ENV": '"production"', global: "window" },
});
const bundle = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const dep = JSON.parse(readFileSync(resolve(root, "deployments.json"), "utf8"));
const table = readFileSync(resolve(root, "scripts/evidence/TABLE.md"), "utf8").split("\n");
const rows = (header) => {
  const i = table.findIndex((l) => l.startsWith("| " + header));
  const r = []; for (let k = i + 2; k < table.length && table[k].startsWith("|"); k++) r.push(table[k].split("|").slice(1, -1).map((s) => s.trim().replace(/\*\*/g, "")));
  return r;
};
const launch = rows("sale |").map((c) => ({ sale: c[0], scenario: c[1], counted: !/not counted as evidence/i.test(c[1]), bids: c[2], leaves: c[3], pstar: c[4], fill: c[5], raise: c[6], lp: c[7], burn: c[8], refunds: c[13], verify: c[14] }));
const sniper = rows("scenario |").map((c) => ({ scenario: c[0], sale: c[1], landed: c[2], when: c[3], winners: c[4], tokens: c[5], pstar: c[6], paid: c[7], botAvg: c[8], honestAvg: c[9], spTime: c[10], spPrice: c[11] }));
const sales = {};
for (const [k, v] of Object.entries(dep.sales)) sales[k] = { account: v.account, keys: v.access_keys_on_chain, wasm: v.sale_wasm_sha256, p_star: v.p_star, alloc_root: v.alloc_root, pool: v.ref_pool_id, txs: v.txs && { create: v.txs.create_sale, finalize: v.txs.finalize_real_outlayer_cleared, settle: v.txs.settle_with_ref_lp } };
const data = { network: dep.network, date: dep.date, factory: dep.factory.account, sales, launch, sniper, saleNames: Object.keys(dep.sales) };
if (launch.length !== 7) throw new Error("expected 7 launch rows, got " + launch.length);
// Evidence = rows TABLE.md does not mark "NOT counted as evidence". Derive headline numbers from them; read the saved verify output for the wording.
const counted = launch.filter((r) => r.counted);
if (counted.length !== 6) throw new Error("expected 6 counted evidence sales, got " + counted.length);
if (launch.filter((r) => !r.counted).map((r) => r.sale).join() !== "sale-n20c") throw new Error("expected only sale-n20c to be not counted");
for (const r of launch) {
  const txt = readFileSync(resolve(root, "scripts/evidence", "verify-" + r.sale + ".sealedlaunch.deathstalker-sl.testnet.txt"), "utf8");
  const m = txt.match(/RESULT: PASS\s+\((\d+) pass, (\d+) fail, (\d+) warn, (\d+) skip\)/);
  if (!m) throw new Error("no PASS RESULT line in saved verify for " + r.sale);
  r.verifyOut = { pass: +m[1], fail: +m[2], warn: +m[3], skip: +m[4] };
}
data.headline = { sales: counted.length, bids: counted.reduce((s, r) => s + parseInt(r.bids, 10), 0), verified: counted.length, verifyOut: counted[0].verifyOut };
if (counted.some((r) => JSON.stringify(r.verifyOut) !== JSON.stringify(counted[0].verifyOut))) throw new Error("verify outputs differ across evidence sales");

const tpl = readFileSync(resolve(here, "template.html"), "utf8");
const html = tpl.replace("/*__EVIDENCE__*/", () => "window.EVIDENCE=" + JSON.stringify(data).replace(/</g, "\\u003c") + ";").replace("/*__BUNDLE__*/", () => bundle);
writeFileSync(resolve(here, "index.html"), html);
// Artifact variant: the Artifact host wraps the page in its own doctype/html/head/body, so emit only title, meta, style, body content.
const art = html.replace(/^<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, "").replace(/<meta charset[^>]*>\s*/i, "").replace(/<meta name="viewport"[^>]*>\s*/i, "").replace(/<\/head>\s*<body>/i, "").replace(/<\/body>\s*<\/html>\s*$/i, "");
writeFileSync(resolve(here, "artifact.html"), art);
console.log("wrote demo/index.html", (html.length / 1024).toFixed(0) + " KB; launch rows:", launch.length, "sniper rows:", sniper.length);
