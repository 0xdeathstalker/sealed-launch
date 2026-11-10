import { createRequire } from "node:module"; const { encryptBid, commitHash, hex } = createRequire(import.meta.url)("./cj.cjs");
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const [sale, pk, tag] = process.argv.slice(2);
const N = 10n ** 24n, T = 10n ** 18n;
const cost = (p, s) => (p * s + T - 1n) / T;
const mk = (who, pN1e4, tokens, extraDepN1e4 = 0n) => ({ who, price: pN1e4 * N / 10000n, size: BigInt(tokens) * T, extra: extraDepN1e4 * N / 10000n });
// price in units of 0.0001 NEAR / token
const bids = [
  mk("dsl-bidder1.testnet", 120n, 200),
  mk("dsl-bidder2.testnet", 110n, 200),
  mk("dsl-bidder3.testnet", 101n, 150),
  mk("dsl-bidder1.testnet", 101n, 50),
  mk("dsl-bidder3.testnet", 50n, 50),   // below reserve -> dropped
  mk("dsl-bidder2.testnet", 102n, 40),
  mk("dsl-bidder1.testnet", 130n, 60),
];
const out = [];
for (const b of bids) {
  const salt = new Uint8Array(randomBytes(32));
  const bid = { price: b.price, size: b.size, salt };
  const ct = encryptBid(pk, bid);
  const commit = hex(commitHash(bid, b.who, sale));
  const dep = cost(b.price, b.size) + b.extra;
  const attached = dep + 10n ** 21n; // + 0.001 fee
  const args = JSON.stringify({ ciphertext: ct, commit });
  const res = execFileSync("near", ["contract","call-function","as-transaction",sale,"bid","json-args",args,"prepaid-gas","30 Tgas","attached-deposit",`${attached} yoctoNEAR`,"sign-as",b.who,"network-config","testnet","sign-with-legacy-keychain","send"], {encoding:"utf8"});
  const tx = /Transaction ID: (\S+)/.exec(res)?.[1];
  const idx = /^\s*(\d+)\s*$/m.exec(res.split("printed to stdout")[1] ?? "")?.[1];
  console.log(b.who, b.price, b.size, "deposit", dep, "tx", tx, "idx", idx);
  out.push({ who: b.who, price: b.price.toString(), size: b.size.toString(), salt: hex(salt), commit, ct, deposit: dep.toString(), tx, idx });
}
fs.writeFileSync(`bids_${tag}.json`, JSON.stringify(out, null, 1));
