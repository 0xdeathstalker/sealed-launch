import {
  clear, entryFromWire, paramsFromWire, leafHash, merkleProof, verifyProof, hex, unhex,
  type ClearingResult, type Entry,
} from "sealedlaunch-clearing";
import type { BidSlot, ClearingSummary, RevealedBid, SaleInfo } from "./types";

const ZERO32 = "0".repeat(64);

/** Rebuild clearing inputs from on-chain slots + published plaintexts (SPEC section 3 "Entry"). */
export function buildEntries(slots: BidSlot[], revealed: (RevealedBid | null)[]): Entry[] {
  return slots.map((s, i) =>
    entryFromWire({
      bidder: s.bidder,
      commit: s.commit || ZERO32,
      deposit: s.deposit,
      plaintext: revealed[i] ?? null,
    }),
  );
}

export function recompute(info: SaleInfo, slots: BidSlot[], revealed: (RevealedBid | null)[], saleId: string): { result: ClearingResult; entries: Entry[] } {
  const p = info.params;
  const entries = buildEntries(slots, revealed);
  const result = clear(
    paramsFromWire({ sale_id: saleId, supply: p.auction_supply, reserve: p.reserve_price, token_decimals: p.token_decimals, min_size: p.min_size }),
    entries,
  );
  return { result, entries };
}

export interface ClaimData { index: number; tokens: bigint; refund: bigint; proof: string[]; proofValid: boolean }

export function claimFor(result: ClearingResult, account: string, onchainRootHex?: string): ClaimData | null {
  const index = result.leaves.findIndex((l) => l.bidder === account);
  if (index < 0) return null;
  const hashes = result.leaves.map(leafHash);
  const proof = merkleProof(hashes, index);
  const root = onchainRootHex ? unhex(onchainRootHex) : result.allocRoot;
  const l = result.leaves[index];
  return {
    index, tokens: l.tokens, refund: l.refund, proof: proof.map(hex),
    proofValid: verifyProof(hashes[index], index, result.leaves.length, proof, root),
  };
}

export interface Check { label: string; mine: string; chain: string; ok: boolean }

/** Field-by-field comparison of the local recompute with `get_clearing`. */
export function compareWithChain(result: ClearingResult, c: ClearingSummary): Check[] {
  const rows: [string, string, string][] = [
    ["P* (clearing price)", result.pStar.toString(), c.p_star],
    ["sold", result.sold.toString(), c.sold],
    ["burned", result.burned.toString(), c.burned],
    ["raise", result.raise.toString(), c.raise],
    ["leaf_count", String(result.leaves.length), String(c.leaf_count)],
    ["alloc_root", hex(result.allocRoot), c.alloc_root],
    ["input_hash", hex(result.inputHash), c.input_hash],
  ];
  return rows.map(([label, mine, chain]) => ({ label, mine, chain, ok: mine === chain }));
}
