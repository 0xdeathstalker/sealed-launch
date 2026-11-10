//! SealedLaunch clearing library. Normative spec: ../SPEC.md (v1).
//!
//! `no_std` + `alloc`. Only dependency: `sha2` (no_std). All arithmetic is
//! integer; 256-bit intermediates are used for price*size products.
#![no_std]
extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];

/// Hard bounds so every sum fits in u128 (2^16 * 2^100 = 2^116).
pub const MAX_BIDS: usize = 1 << 16;
pub const MAX_SUPPLY: u128 = 1u128 << 100;
pub const MAX_BID_SIZE: u128 = 1u128 << 100;
pub const MAX_DECIMALS: u8 = 38;

// ---------------------------------------------------------------- types

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bid {
    pub price: u128,
    pub size: u128,
    pub salt: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct Params {
    pub sale_id: String,
    /// Auction supply in token base units.
    pub supply: u128,
    /// Reserve price: payment-token base units per ONE WHOLE token.
    pub reserve: u128,
    pub token_decimals: u8,
    /// Minimum bid size in token base units (0 = no minimum beyond size > 0).
    pub min_size: u128,
}

#[derive(Clone, Debug)]
pub struct BidEntry {
    pub bidder: String,
    pub commit: Hash,
    /// Escrowed deposit for this entry (payment base units, net of fee).
    pub deposit: u128,
    /// `None` = ciphertext failed to decrypt / was never revealed / cancelled.
    pub plaintext: Option<Bid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DropReason {
    NoPlaintext = 1,
    CommitMismatch = 2,
    BadBid = 3,
    BelowReserve = 4,
    Underfunded = 5,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Dropped(DropReason),
    /// Valid bid; tokens filled (may be 0 for losing bids).
    Filled(u128),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Leaf {
    pub bidder: String,
    pub tokens: u128,
    pub refund: u128,
}

#[derive(Clone, Debug)]
pub struct ClearingResult {
    pub p_star: u128,
    pub supply: u128,
    pub sold: u128,
    pub burned: u128,
    /// Sum over bidders of ceil(p_star * tokens / 10^decimals).
    pub raise: u128,
    pub total_deposits: u128,
    pub input_hash: Hash,
    pub alloc_root: Hash,
    pub leaves: Vec<Leaf>,
    /// One per input entry, same order.
    pub outcomes: Vec<Outcome>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    BadParams,
    TooManyBids,
    Overflow,
    Internal,
}

// ---------------------------------------------------------------- hashing / encoding

fn sha(parts: &[&[u8]]) -> Hash {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn put_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_be_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// commit = sha256(price u128BE ‖ size u128BE ‖ salt[32] ‖ u32BE len‖bidder ‖ u32BE len‖sale)
pub fn commit_hash(bid: &Bid, bidder: &str, sale_id: &str) -> Hash {
    let mut b = Vec::with_capacity(64 + 8 + bidder.len() + sale_id.len());
    b.extend_from_slice(&bid.price.to_be_bytes());
    b.extend_from_slice(&bid.size.to_be_bytes());
    b.extend_from_slice(&bid.salt);
    put_str(&mut b, bidder);
    put_str(&mut b, sale_id);
    sha(&[&b])
}

/// 64-byte plaintext that gets ECIES-encrypted: price ‖ size ‖ salt.
pub fn encode_bid(bid: &Bid) -> [u8; 64] {
    let mut o = [0u8; 64];
    o[..16].copy_from_slice(&bid.price.to_be_bytes());
    o[16..32].copy_from_slice(&bid.size.to_be_bytes());
    o[32..].copy_from_slice(&bid.salt);
    o
}

pub fn decode_bid(b: &[u8]) -> Option<Bid> {
    if b.len() != 64 {
        return None;
    }
    let mut p = [0u8; 16];
    let mut s = [0u8; 16];
    let mut salt = [0u8; 32];
    p.copy_from_slice(&b[..16]);
    s.copy_from_slice(&b[16..32]);
    salt.copy_from_slice(&b[32..]);
    Some(Bid { price: u128::from_be_bytes(p), size: u128::from_be_bytes(s), salt })
}

/// input_hash = sha256("SL1/input" ‖ u32BE len‖sale_id ‖ u32BE n ‖ n×(u32BE len‖bidder ‖ commit ‖ deposit u128BE))
pub fn input_hash(sale_id: &str, entries: &[BidEntry]) -> Hash {
    let mut b = Vec::new();
    b.extend_from_slice(b"SL1/input");
    put_str(&mut b, sale_id);
    b.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for e in entries {
        put_str(&mut b, &e.bidder);
        b.extend_from_slice(&e.commit);
        b.extend_from_slice(&e.deposit.to_be_bytes());
    }
    sha(&[&b])
}

// ---------------------------------------------------------------- wide math

fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// (hi:lo) / d -> (quotient, remainder); None if d == 0 or quotient > u128.
fn div_wide(hi: u128, lo: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 || hi >= d {
        return None;
    }
    let (mut r, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = r >> 127;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || r >= d {
            r = r.wrapping_sub(d);
            q |= 1;
        }
    }
    Some((q, r))
}

/// floor(a*b/d) and remainder, exact.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<(u128, u128)> {
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, d)
}

pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let (q, r) = mul_div(a, b, d)?;
    if r != 0 {
        q.checked_add(1)
    } else {
        Some(q)
    }
}

pub fn pow10(decimals: u8) -> u128 {
    10u128.pow(decimals as u32)
}

/// Payment owed for `tokens` base units at `price` per whole token, rounded UP.
pub fn cost(price: u128, tokens: u128, decimals: u8) -> Option<u128> {
    mul_div_ceil(price, tokens, pow10(decimals))
}

// ---------------------------------------------------------------- merkle

pub fn leaf_hash(l: &Leaf) -> Hash {
    let mut b = Vec::with_capacity(1 + 4 + l.bidder.len() + 32);
    b.push(0x00);
    put_str(&mut b, &l.bidder);
    b.extend_from_slice(&l.tokens.to_be_bytes());
    b.extend_from_slice(&l.refund.to_be_bytes());
    sha(&[&b])
}

fn node_hash(l: &Hash, r: &Hash) -> Hash {
    sha(&[&[0x01], l, r])
}

fn next_level(level: &[Hash]) -> Vec<Hash> {
    let mut out = Vec::with_capacity(level.len().div_ceil(2));
    for c in level.chunks(2) {
        out.push(if c.len() == 2 { node_hash(&c[0], &c[1]) } else { c[0] });
    }
    out
}

/// Root of 0 leaves is 32 zero bytes. Unpaired last node is promoted unchanged.
pub fn merkle_root(leaves: &[Hash]) -> Hash {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<Hash> = leaves.to_vec();
    while level.len() > 1 {
        level = next_level(&level);
    }
    level[0]
}

/// Sibling list, bottom-up. Levels where the node is the unpaired last node contribute no sibling.
pub fn merkle_proof(leaves: &[Hash], mut idx: usize) -> Vec<Hash> {
    let mut proof = Vec::new();
    let mut level: Vec<Hash> = leaves.to_vec();
    while level.len() > 1 {
        if !(level.len() % 2 == 1 && idx == level.len() - 1) {
            proof.push(level[idx ^ 1]);
        }
        level = next_level(&level);
        idx /= 2;
    }
    proof
}

pub fn verify_proof(root: &Hash, leaf: &Hash, mut idx: u64, mut n: u64, proof: &[Hash]) -> bool {
    if n == 0 || idx >= n {
        return false;
    }
    let mut h = *leaf;
    let mut it = proof.iter();
    while n > 1 {
        if !(n % 2 == 1 && idx == n - 1) {
            let Some(s) = it.next() else { return false };
            h = if idx % 2 == 0 { node_hash(&h, s) } else { node_hash(s, &h) };
        }
        idx /= 2;
        n = n.div_ceil(2);
    }
    it.next().is_none() && &h == root
}

// ---------------------------------------------------------------- clearing

struct Valid {
    idx: usize,
    price: u128,
    size: u128,
}

pub fn clear(p: &Params, entries: &[BidEntry]) -> Result<ClearingResult, Error> {
    if p.supply == 0 || p.supply > MAX_SUPPLY || p.token_decimals > MAX_DECIMALS || p.reserve == 0 {
        return Err(Error::BadParams);
    }
    if entries.len() > MAX_BIDS {
        return Err(Error::TooManyBids);
    }
    let dec = p.token_decimals;

    // 1. validate
    let mut outcomes: Vec<Outcome> = Vec::with_capacity(entries.len());
    let mut valid: Vec<Valid> = Vec::new();
    for (idx, e) in entries.iter().enumerate() {
        let o = match &e.plaintext {
            None => Outcome::Dropped(DropReason::NoPlaintext),
            Some(b) => {
                if commit_hash(b, &e.bidder, &p.sale_id) != e.commit {
                    Outcome::Dropped(DropReason::CommitMismatch)
                } else if b.price == 0 || b.size == 0 || b.size < p.min_size || b.size > MAX_BID_SIZE {
                    Outcome::Dropped(DropReason::BadBid)
                } else if b.price < p.reserve {
                    Outcome::Dropped(DropReason::BelowReserve)
                } else {
                    match cost(b.price, b.size, dec) {
                        Some(c) if c <= e.deposit => {
                            valid.push(Valid { idx, price: b.price, size: b.size });
                            Outcome::Filled(0)
                        }
                        _ => Outcome::Dropped(DropReason::Underfunded),
                    }
                }
            }
        };
        outcomes.push(o);
    }

    // 2. sort by price desc (stable; result does not depend on order)
    valid.sort_by(|a, b| b.price.cmp(&a.price).then(a.idx.cmp(&b.idx)));

    // 3. find P*
    let mut fills: BTreeMap<usize, u128> = BTreeMap::new();
    let mut cum: u128 = 0;
    let mut p_star = p.reserve;
    let mut found = false;
    let mut i = 0;
    while i < valid.len() {
        let price = valid[i].price;
        let mut j = i;
        let mut m: u128 = 0;
        while j < valid.len() && valid[j].price == price {
            m = m.checked_add(valid[j].size).ok_or(Error::Overflow)?;
            j += 1;
        }
        let with = cum.checked_add(m).ok_or(Error::Overflow)?;
        if with >= p.supply {
            // marginal level
            found = true;
            p_star = price;
            let r = p.supply - cum;
            let level = &valid[i..j];
            let mut rems: Vec<(u128, usize)> = Vec::new(); // (remainder, index into level)
            let mut floor_sum: u128 = 0;
            for (k, v) in level.iter().enumerate() {
                let (q, rem) = mul_div(v.size, r, m).ok_or(Error::Overflow)?;
                fills.insert(v.idx, q);
                floor_sum += q;
                if rem > 0 {
                    rems.push((rem, k));
                }
            }
            let leftover = r - floor_sum;
            // largest remainder first; tie -> smaller commit, then smaller entry index
            rems.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| entries[level[a.1].idx].commit.cmp(&entries[level[b.1].idx].commit))
                    .then(level[a.1].idx.cmp(&level[b.1].idx))
            });
            if (rems.len() as u128) < leftover {
                return Err(Error::Internal);
            }
            for (_, k) in rems.iter().take(leftover as usize) {
                *fills.get_mut(&level[*k].idx).unwrap() += 1;
            }
            // strictly better bids fill fully
            for v in &valid[..i] {
                fills.insert(v.idx, v.size);
            }
            // strictly worse bids: 0
            for v in &valid[j..] {
                fills.insert(v.idx, 0);
            }
            break;
        }
        cum = with;
        i = j;
    }
    let (sold, burned);
    if !found {
        // undersubscribed (also covers zero valid bids)
        for v in &valid {
            fills.insert(v.idx, v.size);
        }
        sold = cum;
        burned = p.supply - cum;
    } else {
        sold = p.supply;
        burned = 0;
    }
    for (idx, f) in &fills {
        outcomes[*idx] = Outcome::Filled(*f);
    }

    // 4. aggregate per bidder (all entries, dropped ones contribute only deposit)
    let mut agg: BTreeMap<&str, (u128, u128)> = BTreeMap::new(); // (tokens, deposit)
    let mut total_deposits: u128 = 0;
    for (idx, e) in entries.iter().enumerate() {
        let a = agg.entry(e.bidder.as_str()).or_insert((0, 0));
        a.1 = a.1.checked_add(e.deposit).ok_or(Error::Overflow)?;
        total_deposits = total_deposits.checked_add(e.deposit).ok_or(Error::Overflow)?;
        if let Outcome::Filled(f) = outcomes[idx] {
            a.0 += f;
        }
    }
    let mut leaves = Vec::new();
    let mut raise: u128 = 0;
    let mut refunds: u128 = 0;
    for (bidder, (tokens, deposit)) in agg {
        let c = cost(p_star, tokens, dec).ok_or(Error::Overflow)?;
        let refund = deposit.checked_sub(c).ok_or(Error::Internal)?;
        raise = raise.checked_add(c).ok_or(Error::Overflow)?;
        refunds = refunds.checked_add(refund).ok_or(Error::Overflow)?;
        if tokens == 0 && refund == 0 {
            continue; // omit empty leaves
        }
        leaves.push(Leaf { bidder: String::from(bidder), tokens, refund });
    }
    if raise.checked_add(refunds) != Some(total_deposits) {
        return Err(Error::Internal);
    }
    let hashes: Vec<Hash> = leaves.iter().map(leaf_hash).collect();
    Ok(ClearingResult {
        p_star,
        supply: p.supply,
        sold,
        burned,
        raise,
        total_deposits,
        input_hash: input_hash(&p.sale_id, entries),
        alloc_root: merkle_root(&hashes),
        leaves,
        outcomes,
    })
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::string::ToString;
    use alloc::vec;

    fn salt(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn entry(sale: &str, bidder: &str, price: u128, size: u128, s: u8, deposit: u128) -> BidEntry {
        let bid = Bid { price, size, salt: salt(s) };
        BidEntry {
            bidder: bidder.to_string(),
            commit: commit_hash(&bid, bidder, sale),
            deposit,
            plaintext: Some(bid),
        }
    }

    fn params(supply: u128, reserve: u128, dec: u8) -> Params {
        Params { sale_id: "sale.t".to_string(), supply, reserve, token_decimals: dec, min_size: 0 }
    }

    fn tokens_of(r: &ClearingResult, who: &str) -> (u128, u128) {
        r.leaves.iter().find(|l| l.bidder == who).map(|l| (l.tokens, l.refund)).unwrap_or((0, 0))
    }

    #[test]
    fn wide_math() {
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some((u128::MAX, 0)));
        assert_eq!(mul_div(1u128 << 100, 1u128 << 100, 1u128 << 90), Some((1u128 << 110, 0)));
        assert_eq!(mul_div(10, 10, 3), Some((33, 1)));
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
        assert_eq!(mul_div_ceil(10, 10, 3), Some(34));
        assert_eq!(mul_div(5, 5, 0), None);
        // 10^30 * 10^30 / 10^24 = 10^36
        assert_eq!(mul_div(10u128.pow(30), 10u128.pow(30), 10u128.pow(24)), Some((10u128.pow(36), 0)));
    }

    #[test]
    fn oversubscribed_hand_computed() {
        let s = "sale.t";
        let es = vec![
            entry(s, "a", 10, 40, 1, 400),
            entry(s, "b", 8, 30, 2, 240),
            entry(s, "c", 5, 50, 3, 250),
            entry(s, "d", 3, 20, 4, 60),
        ];
        let r = clear(&params(100, 1, 0), &es).unwrap();
        assert_eq!(r.p_star, 5);
        assert_eq!((r.sold, r.burned, r.raise, r.total_deposits), (100, 0, 500, 950));
        assert_eq!(tokens_of(&r, "a"), (40, 200));
        assert_eq!(tokens_of(&r, "b"), (30, 90));
        assert_eq!(tokens_of(&r, "c"), (30, 100));
        assert_eq!(tokens_of(&r, "d"), (0, 60));
    }

    #[test]
    fn undersubscribed_burns_and_clears_at_reserve() {
        let s = "sale.t";
        let es = vec![entry(s, "a", 10, 30, 1, 300), entry(s, "b", 6, 20, 2, 120)];
        let r = clear(&params(100, 4, 0), &es).unwrap();
        assert_eq!((r.p_star, r.sold, r.burned, r.raise), (4, 50, 50, 200));
        assert_eq!(tokens_of(&r, "a"), (30, 180));
        assert_eq!(tokens_of(&r, "b"), (20, 40));
    }

    #[test]
    fn no_valid_bids_burns_everything() {
        let r = clear(&params(100, 4, 0), &[]).unwrap();
        assert_eq!((r.p_star, r.sold, r.burned, r.raise), (4, 0, 100, 0));
        assert_eq!(r.alloc_root, [0u8; 32]);
    }

    #[test]
    fn exact_demand_equals_supply_clears_at_lowest_bid() {
        let s = "sale.t";
        let es = vec![entry(s, "a", 10, 60, 1, 600), entry(s, "b", 7, 40, 2, 280)];
        let r = clear(&params(100, 1, 0), &es).unwrap();
        assert_eq!((r.p_star, r.sold, r.burned), (7, 100, 0));
    }

    #[test]
    fn ties_at_margin_largest_remainder() {
        let s = "sale.t";
        let es = vec![
            entry(s, "w", 9, 2, 1, 18),
            entry(s, "x", 5, 7, 2, 35),
            entry(s, "y", 5, 5, 3, 25),
            entry(s, "z", 5, 3, 4, 15),
        ];
        let r = clear(&params(10, 1, 0), &es).unwrap();
        assert_eq!(r.p_star, 5);
        // R=8, m=15: floors 3,2,1 rem 11,10,9; leftover 2 -> x,y
        assert_eq!(tokens_of(&r, "w").0, 2);
        assert_eq!(tokens_of(&r, "x").0, 4);
        assert_eq!(tokens_of(&r, "y").0, 3);
        assert_eq!(tokens_of(&r, "z").0, 1);
    }

    #[test]
    fn identical_bids_tie_break_by_commit_deterministic() {
        let s = "sale.t";
        // three equal bids, R=1 -> exactly one gets the unit, the one with smallest commit
        let es = vec![entry(s, "p", 5, 1, 1, 5), entry(s, "q", 5, 1, 2, 5), entry(s, "r", 5, 1, 3, 5)];
        let r = clear(&params(1, 1, 0), &es).unwrap();
        let winner = es.iter().min_by_key(|e| e.commit).unwrap().bidder.clone();
        for e in &es {
            assert_eq!(tokens_of(&r, &e.bidder).0, (e.bidder == winner) as u128);
        }
        assert_eq!(r.sold, 1);
    }

    #[test]
    fn dropped_bids() {
        let s = "sale.t";
        let good = entry(s, "good", 5, 10, 1, 50);
        let mut nodecrypt = entry(s, "nd", 5, 10, 2, 50);
        nodecrypt.plaintext = None;
        let mut mismatch = entry(s, "mm", 5, 10, 3, 50);
        mismatch.plaintext.as_mut().unwrap().salt = salt(99);
        let under = entry(s, "un", 5, 10, 4, 49);
        let below = entry(s, "bl", 1, 10, 5, 10);
        let zero = entry(s, "zs", 5, 0, 6, 0);
        let es = vec![good, nodecrypt, mismatch, under, below, zero];
        let r = clear(&params(1000, 2, 0), &es).unwrap();
        assert_eq!(r.outcomes[1], Outcome::Dropped(DropReason::NoPlaintext));
        assert_eq!(r.outcomes[2], Outcome::Dropped(DropReason::CommitMismatch));
        assert_eq!(r.outcomes[3], Outcome::Dropped(DropReason::Underfunded));
        assert_eq!(r.outcomes[4], Outcome::Dropped(DropReason::BelowReserve));
        assert_eq!(r.outcomes[5], Outcome::Dropped(DropReason::BadBid));
        assert_eq!(r.p_star, 2);
        assert_eq!(r.raise, 20);
        assert_eq!(tokens_of(&r, "good"), (10, 30));
        assert_eq!(tokens_of(&r, "nd"), (0, 50));
        assert_eq!(tokens_of(&r, "mm"), (0, 50));
        assert_eq!(tokens_of(&r, "un"), (0, 49));
        assert_eq!(tokens_of(&r, "bl"), (0, 10));
        // zero deposit + zero tokens -> no leaf
        assert!(r.leaves.iter().all(|l| l.bidder != "zs"));
        assert_eq!(r.total_deposits, 50 * 3 + 49 + 10);
    }

    #[test]
    fn single_bidder_oversize_pays_own_price() {
        let s = "sale.t";
        let es = vec![entry(s, "solo", 7, 150, 1, 1050)];
        let r = clear(&params(100, 2, 0), &es).unwrap();
        assert_eq!((r.p_star, r.sold, r.raise), (7, 100, 700));
        assert_eq!(tokens_of(&r, "solo"), (100, 350));
        assert_eq!(r.leaves.len(), 1);
        // single leaf: root == leaf hash
        assert_eq!(r.alloc_root, leaf_hash(&r.leaves[0]));
    }

    #[test]
    fn multiple_bids_same_bidder_aggregate() {
        let s = "sale.t";
        let es = vec![entry(s, "m", 9, 10, 1, 90), entry(s, "m", 4, 10, 2, 40), entry(s, "n", 6, 5, 3, 30)];
        let r = clear(&params(20, 1, 0), &es).unwrap();
        // cum: 10@9, 15@6, 25@4 -> P*=4, R=5, marginal only m's second bid
        assert_eq!(r.p_star, 4);
        assert_eq!(r.leaves.len(), 2);
        assert_eq!(tokens_of(&r, "m"), (15, 130 - 60));
        assert_eq!(tokens_of(&r, "n"), (5, 10));
    }

    #[test]
    fn yocto_scale_rounding_up() {
        // 24 decimals, price 3 yocto per whole token, tokens 1 base unit -> cost ceil(3/1e24)=1
        assert_eq!(cost(3, 1, 24), Some(1));
        let one_near = 10u128.pow(24);
        // 1 NEAR/token, 2.5 tokens -> 2.5 NEAR
        assert_eq!(cost(one_near, 25 * 10u128.pow(23), 24), Some(25 * 10u128.pow(23)));
    }

    #[test]
    fn merkle_proofs_all_sizes() {
        for n in 0..40usize {
            let leaves: Vec<Hash> = (0..n).map(|i| sha(&[&(i as u32).to_be_bytes()])).collect();
            let root = merkle_root(&leaves);
            for i in 0..n {
                let pf = merkle_proof(&leaves, i);
                assert!(verify_proof(&root, &leaves[i], i as u64, n as u64, &pf), "n={n} i={i}");
                // wrong index / wrong leaf / extra sibling must fail
                if n > 1 {
                    let j = (i + 1) % n;
                    assert!(!verify_proof(&root, &leaves[i], j as u64, n as u64, &pf) || pf.is_empty());
                }
                assert!(!verify_proof(&root, &sha(&[b"x"]), i as u64, n as u64, &pf));
                let mut long = pf.clone();
                long.push([0u8; 32]);
                assert!(!verify_proof(&root, &leaves[i], i as u64, n as u64, &long));
            }
        }
    }

    #[test]
    fn bid_codec_roundtrip() {
        let b = Bid { price: 123456789, size: u128::MAX / 7, salt: salt(5) };
        assert_eq!(decode_bid(&encode_bid(&b)), Some(b));
        assert_eq!(decode_bid(&[0u8; 63]), None);
    }

    // ---- property tests with a tiny LCG

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        fn range(&mut self, lo: u128, hi: u128) -> u128 {
            lo + (self.next() as u128 | ((self.next() as u128) << 53)) % (hi - lo + 1)
        }
    }

    pub(crate) fn random_case(seed: u64, dec: u8, price_hi: u128, size_hi: u128) -> (Params, Vec<BidEntry>) {
        let mut g = Lcg(seed);
        let n = g.range(0, 30) as usize;
        let supply = g.range(1, size_hi * 5);
        let p = Params { sale_id: format!("sale{seed}.t"), supply, reserve: g.range(1, price_hi / 4 + 1), token_decimals: dec, min_size: 0 };
        let mut es = Vec::new();
        for k in 0..n {
            let price = g.range(1, price_hi);
            let size = g.range(1, size_hi);
            let bidder = format!("u{}.t", g.range(0, 12));
            let need = cost(price, size, dec).unwrap();
            let bid = Bid { price, size, salt: [k as u8; 32] };
            let mut commit = commit_hash(&bid, &bidder, &p.sale_id);
            let mut plaintext = Some(bid);
            match g.range(0, 11) {
                0 => plaintext = None,
                1 => commit[0] ^= 1,
                _ => {}
            }
            let deposit = if g.range(0, 11) == 2 { need.saturating_sub(1) } else { need + g.range(0, 3) * g.range(0, price_hi) };
            es.push(BidEntry { bidder, commit, deposit, plaintext });
        }
        (p, es)
    }

    fn check_invariants(p: &Params, es: &[BidEntry]) {
        let r = clear(p, es).unwrap();
        // conservation
        let refunds: u128 = r.leaves.iter().map(|l| l.refund).sum();
        let deps: u128 = es.iter().map(|e| e.deposit).sum();
        assert_eq!(r.raise + refunds, deps);
        assert_eq!(r.total_deposits, deps);
        // supply accounting
        let toks: u128 = r.leaves.iter().map(|l| l.tokens).sum();
        assert_eq!(toks, r.sold);
        assert_eq!(r.sold + r.burned, p.supply);
        // fills bounded
        for (i, o) in r.outcomes.iter().enumerate() {
            if let Outcome::Filled(f) = o {
                let b = es[i].plaintext.as_ref().unwrap();
                assert!(*f <= b.size);
                if b.price < r.p_star {
                    assert_eq!(*f, 0);
                }
                if b.price > r.p_star {
                    assert_eq!(*f, b.size);
                }
            }
        }
        assert!(r.p_star >= p.reserve);
        if r.burned > 0 {
            assert_eq!(r.p_star, p.reserve);
        }
        // proofs
        let hs: Vec<Hash> = r.leaves.iter().map(leaf_hash).collect();
        for (i, h) in hs.iter().enumerate() {
            assert!(verify_proof(&r.alloc_root, h, i as u64, hs.len() as u64, &merkle_proof(&hs, i)));
        }
        // permutation invariance of P*, per-bidder allocation (entry order only moves input_hash)
        let mut rev: Vec<BidEntry> = es.to_vec();
        rev.reverse();
        let r2 = clear(p, &rev).unwrap();
        assert_eq!(r2.p_star, r.p_star);
        assert_eq!(r2.leaves, r.leaves);
        assert_eq!(r2.alloc_root, r.alloc_root);
    }

    #[test]
    fn fuzz_small_units() {
        for seed in 0..3000 {
            let (p, es) = random_case(seed, 0, 20, 15);
            check_invariants(&p, &es);
        }
    }

    #[test]
    fn fuzz_yocto_scale() {
        let near = 10u128.pow(24);
        for seed in 0..1500 {
            let (p, es) = random_case(seed + 10_000, 24, 5 * near + 12345, 1000 * near + 777);
            check_invariants(&p, &es);
        }
    }

    #[test]
    fn rejects_bad_params() {
        assert_eq!(clear(&params(0, 1, 0), &[]).err(), Some(Error::BadParams));
        assert_eq!(clear(&params(1, 0, 0), &[]).err(), Some(Error::BadParams));
        assert_eq!(clear(&params(1, 1, 39), &[]).err(), Some(Error::BadParams));
        assert_eq!(clear(&params(MAX_SUPPLY + 1, 1, 0), &[]).err(), Some(Error::BadParams));
    }
}
