// In-memory fake chain for NEXT_PUBLIC_MOCK=1. Uses the REAL clearing-js (commit, ECIES, clear, Merkle),
// so bids are really encrypted and "clearing" really decrypts and clears. Nothing here is a blockchain.
import { PrivateKey } from "eciesjs";
import {
  clear, decryptBid, entryFromWire, paramsFromWire, leafHash, verifyProof, hex, unhex,
} from "sealedlaunch-clearing";
import type { Api } from "./api";
import { FACTORY } from "./config";
import { sealBid } from "./bid";
import { estimateFinalizeDeposit } from "./deposit";
import type {
  BidSlot, BidStatus, ClearingSummary, CreateParamsWire, FactorySaleRecord, PayToken, RevealedBid, SaleInfo,
  TxCall, TxResult,
} from "./types";

export const MOCK_ACCOUNTS = ["alice.testnet", "bob.testnet", "frontrun-bot.testnet"];
const NEAR = 10n ** 24n;
const E18 = 10n ** 18n;
const ZERO32 = "0".repeat(64);

interface MockSale {
  id: string;
  info: SaleInfo;
  slots: BidSlot[];
  times: number[];
  plains: (RevealedBid | null)[];
  sk: string;
  pk: string;
  clearing: ClearingSummary | null;
  claimed: Set<string>;
  creatorKeys: number;
}

const sales = new Map<string, MockSale>();
let seeded = false;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newSale(p: {
  name: string; symbol: string; tokenName: string; endMs: number; auction: bigint; reserve: bigint; minSize?: bigint;
  decimals?: number; lpBps?: number; fee?: bigint; paymentToken?: string | null; creator?: string;
}): MockSale {
  const id = `sale-${p.name}.${FACTORY}`;
  const sk = new PrivateKey();
  const D = p.decimals ?? 18;
  const lpBps = p.lpBps ?? 2000;
  const info: SaleInfo = {
    status: "Bidding", refund_mode: false, mode: "Tee", bid_count: 0, deposits_total: "0", fees_accrued: "0",
    in_flight: false, challenge_end_ns: "0", cleared_at_ns: "0", lp_status: "None", creator_vested: "0", voided: false,
    params: {
      symbol: p.symbol, token_name: p.tokenName, icon: null, token_decimals: D,
      auction_supply: p.auction.toString(), lp_token_reserve: ((p.auction * BigInt(lpBps)) / 10000n).toString(),
      creator_supply: (p.auction / 10n).toString(), reserve_price: p.reserve.toString(),
      min_size: (p.minSize ?? 10n ** BigInt(D)).toString(), bid_fee: (p.fee ?? NEAR / 100n).toString(),
      payment_token: p.paymentToken ?? null, bid_end_ms: String(p.endMs), challenge_secs: 300, lp_bps: lpBps,
      vesting_secs: 30 * 86400, outlayer_project: "deathstalker-sl.testnet/sealedlaunch", code_hash: "607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6",
      max_bids: 200, creator: p.creator ?? "creator.testnet", factory: FACTORY, outlayer: "outlayer.testnet",
      finalize_timeout_secs: 3600, recompute_cap: 200, mode: "Tee", reveal_secs: 0, reveal_bond: "0",
      pubkey: sk.publicKey.toHex(true), ref_exchange: null, wnear: null,
    },
  };
  const s: MockSale = {
    id, info, slots: [], times: [], plains: [], sk: sk.toHex(), pk: sk.publicKey.toHex(true),
    clearing: null, claimed: new Set(), creatorKeys: 0,
  };
  sales.set(id, s);
  return s;
}

function addBid(s: MockSale, bidder: string, price: bigint, size: bigint, deposit: bigint, at: number) {
  const sealed = sealBid({ pkHex: s.pk, saleId: s.id, bidder, price, size });
  s.slots.push({ bidder, commit: sealed.commitHex, ciphertext: sealed.ciphertextHex, deposit: deposit.toString() });
  s.times.push(at);
  s.plains.push(null);
  syncCounts(s);
  return sealed;
}
function syncCounts(s: MockSale) {
  s.info.bid_count = s.slots.length;
  s.info.deposits_total = s.slots.reduce((a, x) => a + BigInt(x.deposit), 0n).toString();
}
const costOf = (price: bigint, size: bigint, D: number) => (price * size + 10n ** BigInt(D) - 1n) / 10n ** BigInt(D);

/** What the TEE would do: decrypt every ciphertext, clear, publish plaintexts. */
function runClearing(s: MockSale) {
  const p = s.info.params;
  s.plains = s.slots.map((sl) => {
    if (!sl.ciphertext) return null;
    const b = decryptBid(s.sk, sl.ciphertext);
    return b ? { price: b.price.toString(), size: b.size.toString(), salt: hex(b.salt) } : null;
  });
  const entries = s.slots.map((sl, i) => entryFromWire({ bidder: sl.bidder, commit: sl.commit, deposit: sl.deposit, plaintext: s.plains[i] }));
  const r = clear(
    paramsFromWire({ sale_id: s.id, supply: p.auction_supply, reserve: p.reserve_price, token_decimals: p.token_decimals, min_size: p.min_size }),
    entries,
  );
  s.clearing = {
    p_star: r.pStar.toString(), sold: r.sold.toString(), burned: r.burned.toString(), raise: r.raise.toString(),
    alloc_root: hex(r.allocRoot), leaf_count: r.leaves.length, input_hash: hex(r.inputHash), status: "Cleared", verified_onchain: true,
  };
  s.info.status = "Cleared";
  s.info.cleared_at_ns = (BigInt(Date.now()) * 1_000_000n).toString();
  return r;
}

function seed() {
  if (seeded) return;
  seeded = true;
  const now = Date.now();
  const rnd = mulberry32(7);
  const humans = Array.from({ length: 18 }, (_, i) => `degen${String(i + 1).padStart(2, "0")}.testnet`);
  const price = (milli: number) => (NEAR * BigInt(Math.round(milli))) / 10000n; // milli = units of 0.0001 NEAR

  // 1) open sale
  const open = newSale({ name: "moonrat", symbol: "MRAT", tokenName: "Moon Rat", endMs: now + 3 * 3600_000 + 12 * 60_000, auction: 1_000_000n * E18, reserve: price(5) });
  const D = 18;
  for (let i = 0; i < 9; i++) {
    const pr = price(5 + Math.floor(rnd() * 35));
    const sz = BigInt(20_000 + Math.floor(rnd() * 130_000)) * E18;
    addBid(open, humans[i], pr, sz, costOf(pr, sz, D), now - 20 * 60_000 + i * 90_000);
  }
  addBid(open, "bob.testnet", price(20), 50_000n * E18, costOf(price(20), 50_000n * E18, D) * 2n, now - 4 * 60_000);

  // 2) cleared sale: oversubscribed, with bots
  const done = newSale({ name: "pepefork", symbol: "PFORK", tokenName: "Pepe Fork", endMs: now - 2 * 86400_000, auction: 1_000_000n * E18, reserve: price(5) });
  const t0 = now - 2 * 86400_000 - 6 * 3600_000;
  const put = (who: string, milli: number, tokens: number, at: number, padBy = 0n) => {
    const pr = price(milli), sz = BigInt(tokens) * E18;
    addBid(done, who, pr, sz, costOf(pr, sz, D) + padBy, at);
  };
  put("frontrun-bot.testnet", 38, 120_000, t0 + 900);
  put("frontrun-bot.testnet", 31, 90_000, t0 + 1_400);
  put("frontrun-bot.testnet", 26, 90_000, t0 + 2_100);
  put("frontrun-bot.testnet", 22, 80_000, t0 + 3_300);
  put("frontrun-bot.testnet", 18, 70_000, t0 + 4_000);
  put("mev-sniper.testnet", 40, 150_000, t0 + 1_100);
  put("mev-sniper.testnet", 12, 150_000, t0 + 2_900);
  put("alice.testnet", 24, 60_000, t0 + 3 * 3600_000, NEAR / 2n);
  humans.forEach((h, i) => {
    const m = 6 + Math.floor(rnd() * 26);
    const tk = 15_000 + Math.floor(rnd() * 110_000);
    put(h, m, tk, t0 + 60_000 * (5 + i * 17));
  });
  runClearing(done);
  const dp = done.info.params;
  dp.pubkey = done.pk;
  // a third, tiny sale already past its end but not finalized, to show "ready to finalize"
  const wait = newSale({ name: "needsfinalize", symbol: "NFZ", tokenName: "Needs Finalize", endMs: now - 60_000, auction: 100_000n * E18, reserve: price(10) });
  for (let i = 0; i < 4; i++) {
    const pr = price(10 + i * 4), sz = BigInt(40_000 + i * 5000) * E18;
    addBid(wait, humans[i], pr, sz, costOf(pr, sz, D), now - 3600_000 + i * 600_000);
  }
}

const err = (m: string): never => { throw new Error(m); };
function get(id: string): MockSale {
  seed();
  return sales.get(id) ?? err(`mock: unknown sale ${id}`);
}
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 40));

function parsePaid(s: MockSale, c: TxCall, caller: string): { amount: bigint; ciphertext: string; commit: string; bidder: string } {
  if (c.methodName === "bid") {
    return { amount: c.deposit, ciphertext: String(c.args.ciphertext), commit: String(c.args.commit), bidder: caller };
  }
  const m = JSON.parse(String(c.args.msg));
  if (m.sale_id !== s.id) err("mock: msg.sale_id mismatch");
  return { amount: BigInt(String(c.args.amount)), ciphertext: m.ciphertext, commit: m.commit, bidder: m.bidder ?? caller };
}

export function mockExec(caller: string, c: TxCall): TxResult {
  seed();
  if (c.methodName === "create_sale" && c.receiverId === FACTORY) {
    const p = c.args.p as CreateParamsWire;
    const id = `sale-${p.name}.${FACTORY}`;
    if (sales.has(id)) err("sale name already taken");
    const s = newSale({
      name: p.name, symbol: p.symbol, tokenName: p.token_name, endMs: Number(p.bid_end_ms), auction: BigInt(p.auction_supply),
      reserve: BigInt(p.reserve_price), minSize: BigInt(p.min_size), decimals: p.token_decimals, lpBps: p.lp_bps,
      fee: BigInt(p.bid_fee), paymentToken: p.payment_token, creator: caller,
    });
    s.info.params.lp_token_reserve = p.lp_token_reserve;
    s.info.params.creator_supply = p.creator_supply;
    s.info.params.challenge_secs = p.challenge_secs;
    s.info.params.vesting_secs = p.vesting_secs;
    s.info.params.max_bids = p.max_bids;
    return { note: `mock: created ${id}` };
  }
  let s: MockSale;
  if (c.methodName === "ft_transfer_call") {
    const target = String(c.args.receiver_id);
    s = get(target);
    if (s.info.params.payment_token !== c.receiverId) err("mock: wrong payment token for this sale");
  } else {
    s = get(c.receiverId);
  }
  const p = s.info.params;
  const D = p.token_decimals;
  const ended = Date.now() >= Number(p.bid_end_ms);
  switch (c.methodName) {
    case "bid":
    case "ft_transfer_call": {
      if (c.methodName === "bid" && p.payment_token) err("this sale takes a NEP-141 payment token");
      if (s.info.status !== "Bidding" || ended) err("bidding is closed");
      if (s.slots.length >= p.max_bids) err("max_bids reached");
      const { amount, ciphertext, commit, bidder } = parsePaid(s, c, caller);
      if (s.slots.some((x) => x.commit === commit)) err("duplicate commit");
      const fee = BigInt(p.bid_fee);
      if (amount <= fee) err("attached must exceed the bid fee");
      s.slots.push({ bidder, commit, ciphertext, deposit: (amount - fee).toString() });
      s.times.push(Date.now());
      s.plains.push(null);
      s.info.fees_accrued = (BigInt(s.info.fees_accrued) + fee).toString();
      syncCounts(s);
      return { note: `mock: slot ${s.slots.length - 1}` };
    }
    case "cancel_bid": {
      const i = Number(c.args.idx);
      const sl = s.slots[i] ?? err("no such slot");
      if (sl.bidder !== caller) err("not your bid");
      if (ended) err("bidding is closed");
      s.slots[i] = { ...sl, deposit: "0", commit: ZERO32, ciphertext: "" };
      syncCounts(s);
      return {};
    }
    case "finalize": {
      if (s.info.status !== "Bidding") err("not in Bidding");
      if (!ended) err("bid window still open");
      // like the contract: the attached NEAR must cover OutLayer's floor for this input size
      const need = estimateFinalizeDeposit(s.slots).required;
      if (BigInt(c.deposit ?? 0n) < need) err(`attached deposit too low for OutLayer: need >= ${need} yoctoNEAR`);
      runClearing(s);
      return { note: "mock: TEE decrypted + cleared instantly (real flow: OutLayer, then on_clear)" };
    }
    case "claim": {
      if (s.info.status !== "Cleared" && s.info.status !== "Settled") err("not cleared");
      const bidder = String(c.args.bidder);
      if (s.claimed.has(bidder)) err("already claimed");
      const proof = (c.args.proof as string[]).map(unhex);
      const leaf = leafHash({ bidder, tokens: BigInt(String(c.args.tokens)), refund: BigInt(String(c.args.refund)) });
      if (!verifyProof(leaf, Number(c.args.index), s.clearing!.leaf_count, proof, unhex(s.clearing!.alloc_root))) err("bad merkle proof");
      s.claimed.add(bidder);
      return { note: "mock: proof verified, claim recorded (no tokens moved)" };
    }
    case "settle": {
      if (s.info.status !== "Cleared") err("not Cleared");
      s.info.status = "Settled";
      s.info.lp_status = "Pending";
      return {};
    }
    case "refund": {
      if (!s.info.refund_mode) err("not in refund mode");
      return {};
    }
    default:
      return err(`mock: method ${c.methodName} not simulated`);
  }
}

export function mockSaleCount() {
  seed();
  return sales.size;
}

/** Effective status including time-derived refund mode is not simulated; mock never enters Refund. */
export const mockApi: Api = {
  requiredDeposit: () => delay(5n * NEAR),
  listSales: () => { seed(); return delay([...sales.keys()].reverse()); },
  factorySale: (name) => {
    seed();
    const s = sales.get(`sale-${name}.${FACTORY}`);
    return delay<FactorySaleRecord | null>(s ? { account: s.id, creator: s.info.params.creator, outlayer_project: s.info.params.outlayer_project, status: "Ready", pubkey: s.pk } : null);
  },
  saleInfo: (id) => delay(structuredClone(get(id).info)),
  pubkey: (id) => delay(get(id).pk),
  clearing: (id) => delay(get(id).clearing ? { ...get(id).clearing! } : null),
  bids: (id, n) => delay(get(id).slots.slice(0, n).map((x) => ({ ...x }))),
  revealed: (id, n) => delay(get(id).plains.slice(0, n)),
  bidStatus: (id, commit): Promise<BidStatus> => {
    const i = get(id).slots.findIndex((x) => x.commit === commit);
    return delay(i >= 0 ? { state: "accepted", idx: i, reason: null } : { state: "unknown", idx: null, reason: null });
  },
  isClaimed: (id, a) => delay(get(id).claimed.has(a)),
  bidTimes: (id) => delay([...get(id).times]),
  finalizeDeposit: (id) => delay(estimateFinalizeDeposit(get(id).slots)),
  payToken: (t): Promise<PayToken> => delay({ symbol: t ? "mUSD" : "NEAR", decimals: t ? 6 : 24, account: t }),
  accessKeys: (a) => {
    seed();
    const known = [...sales.keys()].includes(a);
    return delay(known ? { exists: true, keys: 0 } : { exists: false, keys: null });
  },
  mockFastForward: async (id) => {
    get(id).info.params.bid_end_ms = String(Date.now() - 1000);
  },
};
