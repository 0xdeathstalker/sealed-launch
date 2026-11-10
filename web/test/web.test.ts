import { describe, expect, it } from "vitest";
import { commitHash, decryptBid, hex, unhex, verifyProof, leafHash, merkleRoot } from "sealedlaunch-clearing";
import { PrivateKey } from "eciesjs";
import { formatUnits, parseUnits } from "../lib/format";
import { ftBidMsg, sealBid } from "../lib/bid";
import { claimFor, compareWithChain, recompute } from "../lib/claim";
import { mockApi, mockExec } from "../lib/mock";
import { resultToWire } from "sealedlaunch-clearing";

describe("format", () => {
  it("round-trips decimals", () => {
    expect(parseUnits("1.5", 24)).toBe(1_500_000_000_000_000_000_000_000n);
    expect(formatUnits(1_500_000_000_000_000_000_000_000n, 24)).toBe("1.5");
    expect(parseUnits("0.0005", 24)).toBe(500_000_000_000_000_000_000n);
    expect(parseUnits("1.0000001", 6)).toBeNull();
    expect(parseUnits("abc", 6)).toBeNull();
    expect(parseUnits("", 6)).toBeNull();
    expect(formatUnits(1234567n * 10n ** 18n, 18, 2)).toBe("1,234,567");
  });
});

describe("bid sealing", () => {
  it("commit matches clearing-js and ciphertext decrypts to the bid", () => {
    const sk = new PrivateKey();
    const salt = new Uint8Array(32).fill(7);
    const s = sealBid({ pkHex: sk.publicKey.toHex(true), saleId: "sale-x.f.testnet", bidder: "a.testnet", price: 10n ** 21n, size: 5n * 10n ** 18n, salt });
    expect(s.commitHex).toBe(hex(commitHash(s.bid, "a.testnet", "sale-x.f.testnet")));
    const d = decryptBid(sk.toHex(), s.ciphertextHex)!;
    expect(d.price).toBe(10n ** 21n);
    expect(d.size).toBe(5n * 10n ** 18n);
    expect(hex(d.salt)).toBe(s.saltHex);
    expect(s.ciphertextHex.length).toBe(322);
    const msg = ftBidMsg({ saleId: "sale-x.f.testnet", ciphertext: s.ciphertextHex, commit: s.commitHex, bidder: "a.testnet" });
    expect(msg.length).toBeLessThanOrEqual(1024);
    expect(JSON.parse(msg).commit).toBe(s.commitHex);
  });
});

describe("mock chain end to end (real clearing-js)", () => {
  it("seeded cleared sale: recompute matches get_clearing and claim proofs verify", async () => {
    const ids = await mockApi.listSales();
    const id = ids.find((x) => x.startsWith("sale-pepefork."))!;
    const info = await mockApi.saleInfo(id);
    const cl = (await mockApi.clearing(id))!;
    const slots = await mockApi.bids(id, info.bid_count);
    const rev = await mockApi.revealed(id, info.bid_count);
    const { result } = recompute(info, slots, rev, id);
    expect(compareWithChain(result, cl).every((c) => c.ok)).toBe(true);
    expect(result.raise + result.leaves.reduce((a, l) => a + l.refund, 0n)).toBe(result.totalDeposits);
    for (const l of result.leaves) {
      const c = claimFor(result, l.bidder, cl.alloc_root)!;
      expect(c.proofValid).toBe(true);
      expect(verifyProof(leafHash(l), c.index, cl.leaf_count, c.proof.map(unhex), unhex(cl.alloc_root))).toBe(true);
    }
    expect(hex(merkleRoot(result.leaves.map(leafHash)))).toBe(cl.alloc_root);
    // claim through mock exec, twice
    const a = claimFor(result, "alice.testnet", cl.alloc_root)!;
    const call = { receiverId: id, methodName: "claim", args: { bidder: "alice.testnet", index: a.index, tokens: a.tokens.toString(), refund: a.refund.toString(), proof: a.proof }, gas: 1n, deposit: 0n };
    mockExec("alice.testnet", call);
    expect(() => mockExec("alice.testnet", call)).toThrow(/already claimed/);
    expect(await mockApi.isClaimed(id, "alice.testnet")).toBe(true);
    expect(JSON.stringify(resultToWire(result)).length).toBeGreaterThan(10);
  });

  it("open sale: a bid through the NEAR path is stored, finalize clears it", async () => {
    const id = (await mockApi.listSales()).find((x) => x.startsWith("sale-moonrat."))!;
    const before = (await mockApi.saleInfo(id)).bid_count;
    const pk = (await mockApi.pubkey(id))!;
    const s = sealBid({ pkHex: pk, saleId: id, bidder: "alice.testnet", price: 3n * 10n ** 21n, size: 1000n * 10n ** 18n });
    const dep = (3n * 10n ** 21n * 1000n * 10n ** 18n) / 10n ** 18n;
    mockExec("alice.testnet", { receiverId: id, methodName: "bid", args: { ciphertext: s.ciphertextHex, commit: s.commitHex }, gas: 1n, deposit: dep + 10n ** 22n });
    expect((await mockApi.saleInfo(id)).bid_count).toBe(before + 1);
    expect((await mockApi.bidStatus(id, s.commitHex)).state).toBe("accepted");
    expect(() => mockExec("alice.testnet", { receiverId: id, methodName: "finalize", args: {}, gas: 1n, deposit: 0n })).toThrow(/still open/);
    await mockApi.mockFastForward!(id);
    mockExec("bob.testnet", { receiverId: id, methodName: "finalize", args: {}, gas: 1n, deposit: 0n });
    const cl = (await mockApi.clearing(id))!;
    expect(cl.status).toBe("Cleared");
    const info = await mockApi.saleInfo(id);
    const { result } = recompute(info, await mockApi.bids(id, info.bid_count), await mockApi.revealed(id, info.bid_count), id);
    expect(compareWithChain(result, cl).every((c) => c.ok)).toBe(true);
  });
});
