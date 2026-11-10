//! Generates (GEN_VECTORS=1) and checks vectors.json. Inputs are hand-chosen;
//! the expected block for the small cases is also asserted by hand in src/lib.rs
//! unit tests and cross-checked by an independent Python reference (see SPEC.md).
use sealed_clearing::*;
use serde_json::{json, Value};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
fn h32(s: &str) -> Hash {
    unhex(s).try_into().unwrap()
}
fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

struct Raw {
    bidder: &'static str,
    price: u128,
    size: u128,
    salt: u8,
    deposit: u128,
    mutate: &'static str, // "", "nodecrypt", "badcommit"
}
fn r(bidder: &'static str, price: u128, size: u128, salt: u8, deposit: u128) -> Raw {
    Raw { bidder, price, size, salt, deposit, mutate: "" }
}

const SALE: &str = "sale-demo.sealedlaunch.testnet";

fn build(name: &str, supply: u128, reserve: u128, dec: u8, min_size: u128, raws: Vec<Raw>) -> Value {
    let entries: Vec<Value> = raws
        .iter()
        .map(|x| {
            let bid = Bid { price: x.price, size: x.size, salt: [x.salt; 32] };
            let mut commit = commit_hash(&bid, x.bidder, SALE);
            if x.mutate == "badcommit" {
                commit[31] ^= 0xff;
            }
            let pt = if x.mutate == "nodecrypt" {
                Value::Null
            } else {
                json!({"price": x.price.to_string(), "size": x.size.to_string(), "salt": hex(&bid.salt)})
            };
            json!({"bidder": x.bidder, "commit": hex(&commit), "deposit": x.deposit.to_string(), "plaintext": pt})
        })
        .collect();
    let mut v = json!({
        "name": name,
        "params": {"sale_id": SALE, "supply": supply.to_string(), "reserve": reserve.to_string(),
                   "token_decimals": dec, "min_size": min_size.to_string()},
        "entries": entries,
    });
    v["expected"] = expected(&v);
    v
}

fn parse(v: &Value) -> (Params, Vec<BidEntry>) {
    let p = &v["params"];
    let params = Params {
        sale_id: p["sale_id"].as_str().unwrap().into(),
        supply: u(&p["supply"]),
        reserve: u(&p["reserve"]),
        token_decimals: p["token_decimals"].as_u64().unwrap() as u8,
        min_size: u(&p["min_size"]),
    };
    let es = v["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| BidEntry {
            bidder: e["bidder"].as_str().unwrap().into(),
            commit: h32(e["commit"].as_str().unwrap()),
            deposit: u(&e["deposit"]),
            plaintext: if e["plaintext"].is_null() {
                None
            } else {
                let pt = &e["plaintext"];
                Some(Bid { price: u(&pt["price"]), size: u(&pt["size"]), salt: h32(pt["salt"].as_str().unwrap()) })
            },
        })
        .collect();
    (params, es)
}

fn expected(v: &Value) -> Value {
    let (p, es) = parse(v);
    let res = clear(&p, &es).unwrap();
    json!({
        "p_star": res.p_star.to_string(), "sold": res.sold.to_string(), "burned": res.burned.to_string(),
        "raise": res.raise.to_string(), "total_deposits": res.total_deposits.to_string(),
        "input_hash": hex(&res.input_hash), "alloc_root": hex(&res.alloc_root),
        "leaves": res.leaves.iter().map(|l| json!({"bidder": l.bidder, "tokens": l.tokens.to_string(), "refund": l.refund.to_string(), "leaf_hash": hex(&leaf_hash(l))})).collect::<Vec<_>>(),
        "outcomes": res.outcomes.iter().map(|o| match o {
            Outcome::Filled(f) => json!({"filled": f.to_string()}),
            Outcome::Dropped(d) => json!({"dropped": format!("{:?}", d), "code": *d as u8}),
        }).collect::<Vec<_>>(),
    })
}

fn all_cases() -> Vec<Value> {
    let near = 10u128.pow(24);
    let mut random = Vec::new();
    // deterministic pseudo-random 12-bidder case at yocto scale, odd numbers for rounding stress
    let mut s: u64 = 42;
    let mut nx = |m: u128| -> u128 {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((s >> 20) as u128) % m
    };
    let names = ["a.t", "b.t", "c.t", "d.t", "e.t", "f.t", "g.t", "h.t", "i.t", "j.t", "k.t", "l.t"];
    for (i, n) in names.iter().enumerate() {
        let price = near / 100 * (1 + nx(40)) + nx(1000) * 1_000_003 + 7; // ~0.01..0.4 NEAR/token, ragged
        let size = (50 + nx(400)) * near + nx(near);
        let dep = cost(price, size, 24).unwrap() + nx(5) * 1_000;
        random.push(r(n, price, size, i as u8 + 1, dep));
    }
    vec![
        build("oversubscribed", 100, 1, 0, 0, vec![
            r("a.t", 10, 40, 1, 400), r("b.t", 8, 30, 2, 240), r("c.t", 5, 50, 3, 250), r("d.t", 3, 20, 4, 60)]),
        build("undersubscribed_burn", 100, 4, 0, 0, vec![r("a.t", 10, 30, 1, 300), r("b.t", 6, 20, 2, 120)]),
        build("no_bids", 100, 4, 0, 0, vec![]),
        build("exact_demand", 100, 1, 0, 0, vec![r("a.t", 10, 60, 1, 600), r("b.t", 7, 40, 2, 280)]),
        build("margin_tie_prorata", 10, 1, 0, 0, vec![
            r("w.t", 9, 2, 1, 18), r("x.t", 5, 7, 2, 35), r("y.t", 5, 5, 3, 25), r("z.t", 5, 3, 4, 15)]),
        build("margin_tie_equal_bids", 1, 1, 0, 0, vec![r("p.t", 5, 1, 1, 5), r("q.t", 5, 1, 2, 5), r("r.t", 5, 1, 3, 5)]),
        build("dropped_bids", 1000, 2, 0, 5, vec![
            r("good.t", 5, 10, 1, 50),
            Raw { mutate: "nodecrypt", ..r("nd.t", 5, 10, 2, 50) },
            Raw { mutate: "badcommit", ..r("mm.t", 5, 10, 3, 50) },
            r("un.t", 5, 10, 4, 49),
            r("bl.t", 1, 10, 5, 10),
            r("zs.t", 5, 0, 6, 0),
            r("ms.t", 5, 4, 7, 20)]),
        build("single_bidder", 100, 2, 0, 0, vec![r("solo.t", 7, 150, 1, 1050)]),
        build("same_bidder_two_bids", 20, 1, 0, 0, vec![r("m.t", 9, 10, 1, 90), r("m.t", 4, 10, 2, 40), r("n.t", 6, 5, 3, 30)]),
        build("yocto_rounding_24dec", 1000 * near, near / 100, 24, 0, vec![
            r("a.t", 3 * near / 10 + 1, 400 * near + 1, 1, 130 * near),
            r("b.t", near / 5 + 3, 333 * near + 7, 2, 70 * near),
            r("c.t", near / 5 + 3, 333 * near + 11, 3, 70 * near),
            r("d.t", near / 5 + 3, 777, 4, near / 4)]),
        build("random_12_bidders_24dec", 2000 * near + 13, near / 50, 24, 0, random),
    ]
}

fn merkle_cases() -> Vec<Value> {
    [0usize, 1, 2, 3, 5, 6, 7].iter().map(|&n| {
        let leaves: Vec<Hash> = (0..n).map(|i| leaf_hash(&Leaf { bidder: format!("u{i}.t"), tokens: i as u128 * 10, refund: i as u128 })).collect();
        json!({
            "n": n,
            "leaf_hashes": leaves.iter().map(|h| hex(h)).collect::<Vec<_>>(),
            "root": hex(&merkle_root(&leaves)),
            "proofs": (0..n).map(|i| merkle_proof(&leaves, i).iter().map(|h| hex(h)).collect::<Vec<_>>()).collect::<Vec<_>>(),
        })
    }).collect()
}

fn commit_cases() -> Vec<Value> {
    [(1u128, 2u128, 0u8, "alice.testnet"), (u128::MAX, 1, 0xab, "bob.testnet"), (3 * 10u128.pow(23), 500 * 10u128.pow(24), 7, "c.t")]
        .iter().map(|&(price, size, s, who)| {
            let bid = Bid { price, size, salt: [s; 32] };
            json!({"price": price.to_string(), "size": size.to_string(), "salt": hex(&bid.salt),
                   "bidder": who, "sale": SALE, "plaintext_hex": hex(&encode_bid(&bid)),
                   "commit": hex(&commit_hash(&bid, who, SALE))})
        }).collect()
}

#[test]
fn vectors_json() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors.json");
    if std::env::var("GEN_VECTORS").is_ok() {
        let doc = json!({"version": 1, "sale_id": SALE, "commit_vectors": commit_cases(),
                         "merkle_vectors": merkle_cases(), "clearing_vectors": all_cases()});
        std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("run with GEN_VECTORS=1 first")).unwrap();
    for c in doc["commit_vectors"].as_array().unwrap() {
        let bid = Bid { price: u(&c["price"]), size: u(&c["size"]), salt: h32(c["salt"].as_str().unwrap()) };
        assert_eq!(hex(&encode_bid(&bid)), c["plaintext_hex"].as_str().unwrap());
        assert_eq!(hex(&commit_hash(&bid, c["bidder"].as_str().unwrap(), c["sale"].as_str().unwrap())), c["commit"].as_str().unwrap());
    }
    for m in doc["merkle_vectors"].as_array().unwrap() {
        let leaves: Vec<Hash> = m["leaf_hashes"].as_array().unwrap().iter().map(|h| h32(h.as_str().unwrap())).collect();
        let root = h32(m["root"].as_str().unwrap());
        assert_eq!(merkle_root(&leaves), root);
        for (i, pf) in m["proofs"].as_array().unwrap().iter().enumerate() {
            let pf: Vec<Hash> = pf.as_array().unwrap().iter().map(|h| h32(h.as_str().unwrap())).collect();
            assert!(verify_proof(&root, &leaves[i], i as u64, leaves.len() as u64, &pf));
        }
    }
    for c in doc["clearing_vectors"].as_array().unwrap() {
        assert_eq!(&expected(c), &c["expected"], "case {}", c["name"]);
        // conservation, from the JSON alone
        let e = &c["expected"];
        let refunds: u128 = e["leaves"].as_array().unwrap().iter().map(|l| u(&l["refund"])).sum();
        assert_eq!(u(&e["raise"]) + refunds, u(&e["total_deposits"]), "conservation {}", c["name"]);
    }
}
