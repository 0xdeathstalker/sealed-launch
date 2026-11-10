// Thin chain helpers: raw JSON-RPC views (no keys needed) + near-api-js signing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils, type Account, type Near } from "near-api-js";

// near-api-js prints every failed receipt; we capture failures ourselves.
if (!process.env.NEAR_VERBOSE) (utils as any).Logger.overrideLogger({ log() {}, warn() {}, error() {}, info() {}, debug() {} });

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCRIPTS_DIR = path.resolve(ROOT, "scripts");
export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://testnet.nearblocks.io/txns/";
export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;

export interface Deployments {
  network: string;
  outlayer: { contract: string; project: string; worker_wasm_sha256: string };
  factory: { account: string; owner: string; sale_defaults: Record<string, unknown> };
  accounts: Record<string, unknown>;
  sales: Record<string, { account: string; [k: string]: unknown }>;
}
export const loadDeployments = (): Deployments =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "deployments.json"), "utf8"));

/** Accepts a sale account id or a deployments.json alias (alpha, beta, ...). */
export function resolveSale(arg: string, d = loadDeployments()): string {
  return d.sales[arg]?.account ?? arg;
}

/** Hard guard shared by every script that signs transactions. */
export function requireTestnet(flags: { testnet?: boolean }, d = loadDeployments()): void {
  if (!flags.testnet) die("refusing to run: pass --testnet explicitly");
  if (d.network !== "testnet") die(`deployments.json network is '${d.network}', not testnet`);
  // chain id is verified for real in assertChainTestnet() (async); URL heuristic kept as an early cheap stop
  if (/mainnet/.test(RPC) || /(^|\/\/)rpc\.near\.org/.test(RPC)) die(`NEAR_RPC (${RPC}) looks like mainnet`);
}

export function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

export function parseArgs(argv: string[]): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: any = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const near = (y: bigint) => (Number(y) / 1e24).toFixed(6);
export const toYocto = (n: string | number): bigint => {
  const [i, f = ""] = String(n).split(".");
  return BigInt(i) * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
};

// ------------------------------------------------------------------ raw RPC
let rpcId = 0;
export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      const j: any = await res.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error.data ?? j.error)} [${j.error.code ?? ""}]`);
      return j.result as T;
    } catch (e) {
      if (attempt >= 5 || !/429|fetch failed|ECONN|timeout|502|503/i.test(String(e))) throw e;
      await sleep(700 * (attempt + 1));
    }
  }
}

export async function view<T = any>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const s = Buffer.from(r.result).toString();
  return (s === "" ? null : JSON.parse(s)) as T;
}

export async function accessKeyCount(account: string): Promise<number> {
  const r = await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: account });
  return r.keys.length;
}
export async function balanceOf(account: string): Promise<bigint> {
  const r = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: account });
  return BigInt(r.amount);
}
export async function accountExists(account: string): Promise<boolean> {
  try { await balanceOf(account); return true; } catch { return false; }
}
export async function nowChainMs(): Promise<number> {
  const b = await rpc<any>("block", { finality: "final" });
  return Number(BigInt(b.header.timestamp) / 1_000_000n);
}
export async function blockTimeMs(blockHash: string): Promise<number> {
  const b = await rpc<any>("block", { block_id: blockHash });
  return Number(BigInt(b.header.timestamp) / 1_000_000n);
}
export async function txInfo(hash: string, signer: string) {
  return rpc<any>("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
}
export function gasBurnt(tx: any): bigint {
  let g = BigInt(tx.transaction_outcome.outcome.gas_burnt);
  for (const r of tx.receipts_outcome ?? []) g += BigInt(r.outcome.gas_burnt);
  return g;
}
export const txLink = (h?: string) => (h ? EXPLORER + h : "");

// ------------------------------------------------------------------ signing
const KEY_DIRS = [path.join(SCRIPTS_DIR, ".keys"), path.join(os.homedir(), ".near-credentials/testnet")];

export function loadSecretKey(account: string): string | null {
  for (const dir of KEY_DIRS) {
    const f = path.join(dir, `${account}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).private_key as string;
  }
  return null;
}
export function saveKey(account: string, kp: KeyPair): void {
  fs.mkdirSync(KEY_DIRS[0], { recursive: true });
  fs.writeFileSync(
    path.join(KEY_DIRS[0], `${account}.json`),
    JSON.stringify({ account_id: account, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
    { mode: 0o600 },
  );
}

let _near: Near | null = null;
const ks = new keyStores.InMemoryKeyStore();
async function conn(): Promise<Near> {
  return (_near ??= await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks }));
}
const accountCache = new Map<string, Account>();
export async function signer(accountId: string): Promise<Account> {
  const hit = accountCache.get(accountId);
  if (hit) return hit;
  const sk = loadSecretKey(accountId);
  if (!sk) die(`no key found for ${accountId} (looked in ${KEY_DIRS.join(", ")})`);
  await ks.setKey("testnet", accountId, KeyPair.fromString(sk as any));
  const a = await (await conn()).account(accountId);
  accountCache.set(accountId, a);
  return a;
}

export interface CallResult {
  ok: boolean;
  tx?: string;
  error?: string;
  result?: any;
  gasBurnt?: bigint;
  blockHash?: string;
  /** failure surfaced in a later receipt (cross-contract) rather than the first one */
  receiptFailure?: string;
}

function decodeSuccess(o: any): any {
  const sv = o?.status?.SuccessValue;
  if (sv === undefined || sv === "") return null;
  try { return JSON.parse(Buffer.from(sv, "base64").toString()); } catch { return sv; }
}

/** Sign + send a function call, never throws; surfaces first-receipt AND later-receipt failures. */
export async function call(
  from: string, contract: string, method: string, args: object,
  opts: { gas?: bigint; deposit?: bigint } = {},
): Promise<CallResult> {
  const acc = await signer(from);
  try {
    const o: any = await acc.functionCall({
      contractId: contract, methodName: method, args,
      gas: (opts.gas ?? 100n * TGAS) as any, attachedDeposit: (opts.deposit ?? 0n) as any,
    });
    const tx = o.transaction_outcome.id as string;
    let receiptFailure: string | undefined;
    for (const r of o.receipts_outcome ?? []) {
      const f = r.outcome?.status?.Failure;
      if (f) { receiptFailure = JSON.stringify(f).slice(0, 400); break; }
    }
    let g = BigInt(o.transaction_outcome.outcome.gas_burnt);
    for (const r of o.receipts_outcome ?? []) g += BigInt(r.outcome.gas_burnt);
    return { ok: !receiptFailure, tx, blockHash: o.transaction_outcome.block_hash as string, result: decodeSuccess(o), gasBurnt: g, receiptFailure };
  } catch (e: any) {
    const tx = e?.context?.transactionHash ?? e?.transaction_outcome?.id ?? e?.transactionHash;
    return { ok: false, tx, error: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 500) };
  }
}

/** Async guard: the RPC must report chain_id == testnet. Call once at start of any signing script. */
export async function assertChainTestnet(): Promise<void> {
  const st = await rpc<{ chain_id: string }>("status", []);
  if (st.chain_id !== "testnet") die(`RPC chain_id is '${st.chain_id}', refusing`);
}
