import { commitHash, encryptBid, hex, cost, type Bid } from "sealedlaunch-clearing";
import { TGAS } from "./config";
import type { TxCall } from "./types";

export interface SealedBid {
  bid: Bid;
  saltHex: string;
  commitHex: string;
  ciphertextHex: string;
}

export function randomSalt(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

/** Build commit + ECIES ciphertext exactly as SPEC section 2. `salt` is injectable for tests. */
export function sealBid(o: {
  pkHex: string; saleId: string; bidder: string; price: bigint; size: bigint; salt?: Uint8Array;
}): SealedBid {
  const bid: Bid = { price: o.price, size: o.size, salt: o.salt ?? randomSalt() };
  return {
    bid,
    saltHex: hex(bid.salt),
    commitHex: hex(commitHash(bid, o.bidder, o.saleId)),
    ciphertextHex: encryptBid(o.pkHex, bid),
  };
}

export const requiredDeposit = (price: bigint, size: bigint, decimals: number) => cost(price, size, decimals);

/** `msg` for ft_transfer_call (contracts/sale `FtBidMsg`): JSON text, max 1024 chars. */
export function ftBidMsg(o: { saleId: string; ciphertext: string; commit: string; bidder: string }): string {
  const msg = JSON.stringify({ v: 1, sale_id: o.saleId, ciphertext: o.ciphertext, commit: o.commit, bidder: o.bidder, refund_to: null });
  if (msg.length > 1024) throw new Error(`ft_transfer_call msg is ${msg.length} chars (max 1024)`);
  return msg;
}

/** NEAR-paid sale: attached = fee + deposit. */
export function nearBidCall(saleId: string, s: SealedBid, fee: bigint, deposit: bigint): TxCall {
  return {
    receiverId: saleId, methodName: "bid", args: { ciphertext: s.ciphertextHex, commit: s.commitHex },
    gas: 60n * TGAS, deposit: fee + deposit,
  };
}
/** NEP-141-paid sale: ft_transfer_call on the payment token; `amount` includes the fee. */
export function ftBidCall(paymentToken: string, saleId: string, bidder: string, s: SealedBid, amount: bigint): TxCall {
  return {
    receiverId: paymentToken, methodName: "ft_transfer_call",
    args: { receiver_id: saleId, amount: amount.toString(), msg: ftBidMsg({ saleId, ciphertext: s.ciphertextHex, commit: s.commitHex, bidder }) },
    gas: 100n * TGAS, deposit: 1n,
  };
}

// ---------------------------------------------------------------- local receipts (salt backup)

export interface Receipt {
  v: 1;
  saleId: string;
  bidder: string;
  commit: string;
  salt: string;
  price: string;
  size: string;
  deposit: string;
  ciphertext: string;
  createdAt: number;
  txHash?: string;
}
const key = (saleId: string, bidder: string) => `sl:receipts:${saleId}:${bidder}`;

export function loadReceipts(saleId: string, bidder: string): Receipt[] {
  try {
    return JSON.parse(localStorage.getItem(key(saleId, bidder)) || "[]") as Receipt[];
  } catch {
    return [];
  }
}
export function saveReceipt(r: Receipt) {
  const all = loadReceipts(r.saleId, r.bidder).filter((x) => x.commit !== r.commit);
  all.push(r);
  localStorage.setItem(key(r.saleId, r.bidder), JSON.stringify(all));
}
export function receiptJson(r: Receipt): string {
  return JSON.stringify(r, null, 2);
}
export function downloadReceipt(r: Receipt) {
  const blob = new Blob([receiptJson(r)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sealedlaunch-bid-${r.commit.slice(0, 8)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
