// claim every still-unclaimed leaf of a cleared sale (claims are permissionless + proof-checked).
// usage: claimrest.mts <sale> <caller1,caller2,...>   leaves are spread round-robin; each caller runs sequentially, callers in parallel
import { call, view, TGAS, txLink } from "../src/lib/chain.ts";
import { fetchSale, recompute } from "../src/lib/sale.ts";
import { leafHash, merkleProof, hex } from "sealedlaunch-clearing";
const [sale, callersArg] = process.argv.slice(2); const callers = callersArg.split(",");
const cs = await fetchSale(sale); const rc = recompute(cs); const lh = rc.result.leaves.map(leafHash);
const todo: number[] = [];
for (let i = 0; i < rc.result.leaves.length; i++) if (!(await view<boolean>(sale, "is_claimed", { account_id: rc.result.leaves[i].bidder }))) todo.push(i);
console.log("unclaimed leaves:", todo.length, "of", rc.result.leaves.length);
let ok = 0, fail = 0;
await Promise.all(callers.map(async (caller, c) => {
  for (let k = c; k < todo.length; k += callers.length) {
    const i = todo[k], l = rc.result.leaves[i];
    const r = await call(caller, sale, "claim", { bidder: l.bidder, index: i, tokens: l.tokens.toString(), refund: l.refund.toString(), proof: merkleProof(lh, i).map(hex) }, { gas: 30n * TGAS });
    if (r.ok) ok++; else { fail++; console.log(l.bidder, "FAIL", String(r.error).slice(0, 120), txLink(r.tx)); }
  }
}));
console.log("claimed ok", ok, "fail", fail);
