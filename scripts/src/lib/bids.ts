import { randomBytes } from "node:crypto";
import { encryptBid, commitHash, cost, hex } from "sealedlaunch-clearing";
import { call, view, loadDeployments, die, accountExists, saveKey, sleep, TGAS, type CallResult } from "./chain.ts";
import { KeyPair } from "near-api-js";
import type { SaleInfo } from "./sale.ts";

/** Refuse to touch anything that is not a sale of OUR factory from deployments.json. */
export function assertOurSale(sale: string, info: SaleInfo): void {
  const d = loadDeployments();
  if (!sale.endsWith("." + d.factory.account)) die(`refusing: ${sale} is not a sub-account of factory ${d.factory.account}`);
  if (info.params.factory !== d.factory.account) die(`refusing: sale.params.factory=${info.params.factory} != ${d.factory.account}`);
}

export async function getPubkey(sale: string): Promise<string> {
  const pk = await view<string | null>(sale, "get_pubkey");
  if (!pk) die(`${sale} has no pk_sale yet (not Ready)`);
  return pk!;
}

export interface BidPlan { account: string; price: bigint; size: bigint }
export interface BidRecord {
  account: string; price: string; size: string; salt: string; commit: string; ciphertext_len: number;
  deposit: string; attached: string; submit_ms?: number; send_done_ms?: number;
  tx?: string; idx?: number | null; block_ts_ms?: number; before_deadline?: boolean | null;
  ok?: boolean; error?: string; gas_burnt?: string;
}

export function prepareBid(sale: string, pk: string, info: SaleInfo, plan: BidPlan) {
  const D = info.params.token_decimals;
  const salt = new Uint8Array(randomBytes(32));
  const bid = { price: plan.price, size: plan.size, salt };
  const deposit = cost(plan.price, plan.size, D);
  if (deposit === null) throw new Error("cost overflow");
  const attached = deposit + BigInt(info.params.bid_fee);
  const rec: BidRecord = {
    account: plan.account, price: plan.price.toString(), size: plan.size.toString(), salt: hex(salt),
    commit: hex(commitHash(bid, plan.account, sale)), ciphertext_len: 0,
    deposit: deposit.toString(), attached: attached.toString(),
  };
  const ciphertext = encryptBid(pk, bid);
  rec.ciphertext_len = ciphertext.length / 2;
  return { rec, ciphertext, attached };
}

export async function sendBid(sale: string, prepared: ReturnType<typeof prepareBid>, bidEndMs: number): Promise<BidRecord> {
  const { rec, ciphertext, attached } = prepared;
  rec.submit_ms = Date.now();
  const r: CallResult = await call(rec.account, sale, "bid", { ciphertext, commit: rec.commit }, { gas: BigInt(process.env.BID_GAS_TGAS ?? 6) * TGAS, deposit: attached });
  rec.send_done_ms = Date.now();
  rec.tx = r.tx; rec.ok = r.ok; rec.error = r.error ?? r.receiptFailure;
  rec.idx = typeof r.result === "number" ? r.result : null;
  rec.gas_burnt = r.gasBurnt?.toString();
  if (r.blockHash) {
    const { blockTimeMs } = await import("./chain.ts");
    rec.block_ts_ms = await blockTimeMs(r.blockHash);
    rec.before_deadline = rec.block_ts_ms < bidEndMs;
  }
  return rec;
}

/** Create a testnet account through the public helper (faucet) with a fresh key stored in scripts/.keys. */
export async function createFaucetAccount(id: string): Promise<void> {
  if (await accountExists(id)) return;
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch("https://helper.testnet.near.org/account", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet create ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  saveKey(id, kp);
  for (let i = 0; i < 20 && !(await accountExists(id)); i++) await sleep(1000);
}
