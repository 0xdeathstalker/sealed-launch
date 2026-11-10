#!/usr/bin/env tsx
// Usage: pnpm verify <sale_account|alias> [--json] [--all]
import { parseArgs, resolveSale, loadDeployments, die } from "./lib/chain.ts";
import { verifySale, printReport } from "./lib/verify-core.ts";

const a = parseArgs(process.argv.slice(2));
const d = loadDeployments();
const targets = a.all ? Object.values(d.sales).map((s) => s.account) : a._.map((x) => resolveSale(x, d));
if (!targets.length) die("usage: verify <sale_account|alias> [--json] [--all]");
let bad = false;
const reps = [];
for (const t of targets) {
  const rep = await verifySale(t);
  reps.push(rep);
  if (!a.json) printReport(rep);
  if (!rep.pass) bad = true;
}
if (a.json) console.log(JSON.stringify(reps.length === 1 ? reps[0] : reps, null, 2));
process.exit(bad ? 1 : 0);
