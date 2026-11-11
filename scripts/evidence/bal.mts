import { balanceOf, near } from "../src/lib/chain.ts";
let t = 0n; for (const a of process.argv.slice(2)) { const b = await balanceOf(a).catch(() => 0n); t += b; console.log(a, near(b)); } console.log("TOTAL", near(t));
