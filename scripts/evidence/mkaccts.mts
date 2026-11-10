import { createFaucetAccount } from "../src/lib/bids.ts";
import { balanceOf, near } from "../src/lib/chain.ts";
const ids = process.argv.slice(2);
for (const id of ids) { try { await createFaucetAccount(id); console.log(id, near(await balanceOf(id))); } catch (e) { console.log(id, "ERR", String(e).slice(0,200)); } }
