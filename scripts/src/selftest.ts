// Negative tests for verify: tampered chain data must produce FAIL. Read-only.
import { fetchSale } from "./lib/sale.ts";
import { verifySale } from "./lib/verify-core.ts";
import { loadDeployments } from "./lib/chain.ts";

const sale = loadDeployments().sales.beta.account;
const base = await fetchSale(sale);
const clone = () => structuredClone(base);
const cases: [string, (c: typeof base) => void, string][] = [
  ["untouched", () => {}, "PASS"],
  ["revealed price of slot 0 altered", (c) => { c.revealed[0]!.price = (BigInt(c.revealed[0]!.price) + 1n).toString(); }, "FAIL"],
  ["slot deposit altered", (c) => { c.slots[1].deposit = (BigInt(c.slots[1].deposit) + 1n).toString(); }, "FAIL"],
  ["clearing.p_star altered", (c) => { c.clearing!.p_star = (BigInt(c.clearing!.p_star) + 1n).toString(); }, "FAIL"],
  ["clearing.alloc_root altered", (c) => { c.clearing!.alloc_root = "00".repeat(32); }, "FAIL"],
  ["optional slot.ts present (new factory shape)", (c) => { c.slots.forEach((s, i) => (s.ts = 1794340000000 + i)); }, "PASS"],
];
let bad = 0;
for (const [name, mut, want] of cases) {
  const c = clone(); mut(c);
  const rep = await verifySale(sale, c);
  const got = rep.pass ? "PASS" : "FAIL";
  const failed = rep.checks.filter((x) => x.level === "FAIL").map((x) => x.name).slice(0, 3).join("; ");
  console.log(`${got === want ? "ok  " : "BAD "} ${name}: verify=${got} (want ${want}) ${failed}`);
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
