// helper: node-style account ops for evidence runs (testnet only, project accounts only)
//  acct.mts send <from> <to> <near> | create <parent> <prefix> <count> <near> [startIdx] | delete <from> <beneficiary>...
import { KeyPair } from "near-api-js";
import { signer, saveKey, accountExists, balanceOf, near, toYocto, requireTestnet, assertChainTestnet, sleep } from "../src/lib/chain.ts";
await assertChainTestnet();
const [cmd, ...r] = process.argv.slice(2);
const OK = /(^|\.)(deathstalker-sl(-\d+)?|dsl-[a-z0-9-]+)\.testnet$/;
const chk = (x: string) => { if (!OK.test(x)) throw new Error("not a project account: " + x); };
if (cmd === "send") { chk(r[0]); chk(r[1]); const a = await signer(r[0]); await a.sendMoney(r[1], toYocto(r[2]) as any); console.log("sent", near(await balanceOf(r[1]))); }
if (cmd === "create") {
  const [parent, prefix, count, amt, start = "1"] = r; chk(parent);
  const p = await signer(parent);
  const ids: string[] = [];
  for (let i = Number(start); i < Number(start) + Number(count); i++) ids.push(`${prefix}${i}.${parent}`);
  const todo = ids.filter(() => true);
  let idx = 0;
  const worker = async () => { for (;;) { const id = todo[idx++]; if (!id) return;
    if (await accountExists(id)) continue;
    const kp = KeyPair.fromRandom("ed25519"); saveKey(id, kp);
    for (let t = 0; t < 4; t++) { try { await p.createAccount(id, kp.getPublicKey().toString(), toYocto(amt) as any); break; } catch (e) { if (t == 3) console.log("ERR", id, String(e).slice(0, 150)); await sleep(1500); } } } };
  // single signer => sequential nonces
  await worker();
  console.log("created", ids.length, "last", ids[ids.length - 1]);
}
if (cmd === "delete") { for (const id of r.slice(1)) { chk(id); try { const a = await signer(id); await a.deleteAccount(r[0]); console.log("deleted", id); } catch (e) { console.log("ERR", id, String(e).slice(0, 120)); } } }
if (cmd === "topup") { // topup <parent> <prefix> <count> <near>: sendMoney from parent to prefix{i}.parent
  const [parent, prefix, count, amt] = r; chk(parent); const p = await signer(parent);
  for (let i = 1; i <= Number(count); i++) { for (let t = 0; t < 4; t++) { try { await p.sendMoney(`${prefix}${i}.${parent}`, toYocto(amt) as any); break; } catch (e) { if (t == 3) console.log("ERR", i, String(e).slice(0, 100)); await sleep(1500); } } }
  console.log("topped", count);
}
