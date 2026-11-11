// Negative tests for verify: tampered chain data must produce FAIL. Read-only.
import { fetchSale, outlayerRequiredDeposit, recommendedDeposit, estimateInputLen } from "./lib/sale.ts";
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
// finalize deposit: same numbers as contracts/sale deposit_tests (spike input sizes 10/100/200 bids)
const dep: [string, boolean][] = [
  ["n=10 4,904 B -> 0.0070005", outlayerRequiredDeposit(4_904, 10) === 7_000_500_000_000_000_000_000n],
  ["n=100 48,734 B -> 0.1666605", outlayerRequiredDeposit(48_734, 100) === 166_660_500_000_000_000_000_000n],
  ["n=200 97,734 B -> 0.6566607", outlayerRequiredDeposit(97_734, 200) === 656_660_700_000_000_000_000_000n],
  ["live n100 49,521 B -> 0.17453 (> flat 0.1)", outlayerRequiredDeposit(49_521, 100) === 174_530_500_000_000_000_000_000n],
  ["recommended(0.17453) = 0.219", recommendedDeposit(174_530_500_000_000_000_000_000n) === 219_000_000_000_000_000_000_000n],
];
// read-only: client estimate for the live 100-bid sale must cover its real input (49,521 B per OutLayer's error)
try {
  const n100 = await fetchSale("sale-n100.sealedlaunch.deathstalker-sl.testnet");
  const est = estimateInputLen(n100.slots);
  dep.push([`estimateInputLen(sale-n100)=${est} >= 49,521 and within 1%`, est >= 49_521 && est <= 49_521 * 1.01]);
} catch (e) { console.log(`skip live n100 estimate check: ${(e as Error).message}`); }
for (const [name, okd] of dep) { console.log(`${okd ? "ok  " : "BAD "} finalize deposit: ${name}`); if (!okd) bad++; }
process.exit(bad ? 1 : 0);
