import type { Api } from "./api";
import { FACTORY } from "./config";
import { viewAccessKeys, viewCall } from "./rpc";
import type { BidSlot, BidStatus, ClearingSummary, FactorySaleRecord, PayToken, RevealedBid, SaleInfo } from "./types";

async function inBatches<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(f))));
  return out;
}

export const chainApi: Api = {
  async requiredDeposit() {
    return BigInt(await viewCall<string>(FACTORY, "get_required_deposit"));
  },
  async listSales() {
    const out: string[] = [];
    for (let from = 0; ; from += 50) {
      const page = await viewCall<string[]>(FACTORY, "list_sales", { from, limit: 50 });
      out.push(...page);
      if (page.length < 50) break;
    }
    return out;
  },
  async factorySale(name) {
    return viewCall<FactorySaleRecord | null>(FACTORY, "get_sale", { name });
  },
  saleInfo: (id) => viewCall<SaleInfo>(id, "get_sale"),
  pubkey: (id) => viewCall<string | null>(id, "get_pubkey"),
  clearing: (id) => viewCall<ClearingSummary | null>(id, "get_clearing"),
  async bids(id, count) {
    return inBatches(Array.from({ length: count }, (_, i) => i), 16, (idx) => viewCall<BidSlot>(id, "get_bid", { idx }));
  },
  async revealed(id, count) {
    const out: (RevealedBid | null)[] = [];
    for (let from = 0; from < count; from += 50) {
      out.push(...(await viewCall<(RevealedBid | null)[]>(id, "get_revealed_bids", { from, limit: 50 })));
    }
    return out;
  },
  bidStatus: (id, commit) => viewCall<BidStatus>(id, "bid_status", { commit }),
  isClaimed: (id, account_id) => viewCall<boolean>(id, "is_claimed", { account_id }),
  async bidTimes() {
    return null;
  },
  async payToken(token): Promise<PayToken> {
    if (!token) return { symbol: "NEAR", decimals: 24, account: null };
    try {
      const m = await viewCall<{ symbol: string; decimals: number }>(token, "ft_metadata");
      return { symbol: m.symbol, decimals: m.decimals, account: token };
    } catch {
      return { symbol: token, decimals: 0, account: token };
    }
  },
  async accessKeys(account) {
    try {
      const r = await viewAccessKeys(account);
      return { exists: true, keys: r.keys.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|UNKNOWN_ACCOUNT|UnknownAccount/i.test(msg)) return { exists: false, keys: null };
      return { exists: false, keys: null, error: msg };
    }
  },
};
