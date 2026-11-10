use serde_json::{json, Value};
use sl_worker::{run, Env};

const MASTER: [u8; 32] = [0x5a; 32];
const NS: u128 = 1_000_000;
const BID_END_MS: u64 = 1_700_000_000_000;
const CODE_HASH: &str = "aa00000000000000000000000000000000000000000000000000000000000001";

fn env(pred: &str, ts_ns: u128) -> Env {
    Env { master_hex: hex::encode(MASTER), predecessor: pred.into(), block_ts_ns: ts_ns.to_string() }
}
fn after() -> u128 { BID_END_MS as u128 * NS + 1 }

fn keys(sale: &str) -> (Vec<u8>, Vec<u8>) {
    let out = run(&json!({"action":"derive_pubkey","sale":sale}).to_string(), &env(sale, 0)).unwrap();
    let pk = hex::decode(out["pubkey"].as_str().unwrap()).unwrap();
    (pk, vec![])
}
fn enc(sale: &str, plain: &[u8]) -> String {
    let (pk, _) = keys(sale);
    hex::encode(ecies::encrypt(&pk, plain).unwrap())
}
fn vectors() -> Value { serde_json::from_str(&std::fs::read_to_string("../clearing/vectors.json").unwrap()).unwrap() }
fn fixtures() -> Value { serde_json::from_str(&std::fs::read_to_string("fixtures/fixtures.json").unwrap()).unwrap() }

fn bid_bytes(p: &Value) -> Vec<u8> {
    let mut b = vec![];
    b.extend_from_slice(&p["price"].as_str().unwrap().parse::<u128>().unwrap().to_be_bytes());
    b.extend_from_slice(&p["size"].as_str().unwrap().parse::<u128>().unwrap().to_be_bytes());
    b.extend_from_slice(&hex::decode(p["salt"].as_str().unwrap()).unwrap());
    b
}
fn clear_input(case: &Value, entries: Vec<Value>) -> String {
    let p = &case["params"];
    json!({"action":"clear","params":{
        "sale_id":p["sale_id"],"supply":p["supply"],"reserve":p["reserve"],"token_decimals":p["token_decimals"],
        "min_size":p["min_size"],"bid_end_ms":BID_END_MS,"code_hash":CODE_HASH},"entries":entries}).to_string()
}

fn check_against(case: &Value, out: &Value, name: &str) {
    let e = &case["expected"];
    for k in ["p_star", "sold", "burned", "raise", "input_hash", "alloc_root"] {
        assert_eq!(out[k], e[k], "{} field {}", name, k);
    }
    assert_eq!(out["leaf_count"].as_u64().unwrap() as usize, e["leaves"].as_array().unwrap().len(), "{}", name);
    assert_eq!(out["code_hash"], CODE_HASH);
    assert_eq!(out["sale_id"], case["params"]["sale_id"]);
    let es = case["entries"].as_array().unwrap();
    let pts = out["plaintexts"].as_array().unwrap();
    assert_eq!(pts.len(), es.len());
    for (e, p) in es.iter().zip(pts) {
        assert_eq!(&e["plaintext"], p, "{} plaintext", name);
    }
}

#[test]
fn all_clearing_vectors_via_ecies_roundtrip() {
    let v = vectors();
    let mut n = 0;
    for case in v["clearing_vectors"].as_array().unwrap() {
        let sale = case["params"]["sale_id"].as_str().unwrap();
        let entries: Vec<Value> = case["entries"].as_array().unwrap().iter().map(|e| {
            let ct = if e["plaintext"].is_null() { "deadbeef".to_string() } else { enc(sale, &bid_bytes(&e["plaintext"])) };
            json!({"bidder":e["bidder"],"commit":e["commit"],"deposit":e["deposit"],"ciphertext":ct})
        }).collect();
        let out = run(&clear_input(case, entries), &env(sale, after())).unwrap();
        check_against(case, &out, case["name"].as_str().unwrap());
        n += 1;
    }
    assert_eq!(n, 11);
}

#[test]
fn base64_transport_works() {
    use base64::Engine;
    let v = vectors();
    let case = &v["clearing_vectors"][0];
    let sale = case["params"]["sale_id"].as_str().unwrap();
    let entries: Vec<Value> = case["entries"].as_array().unwrap().iter().map(|e| {
        let (pk, _) = keys(sale);
        let ct = ecies::encrypt(&pk, &bid_bytes(&e["plaintext"])).unwrap();
        json!({"bidder":e["bidder"],"commit":e["commit"],"deposit":e["deposit"],
               "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(ct)})
    }).collect();
    let out = run(&clear_input(case, entries), &env(sale, after())).unwrap();
    check_against(case, &out, "b64");
}

#[test]
fn js_eciesjs_ciphertexts_decrypt() {
    let f = fixtures();
    assert!(f["eciesjs_version"].as_str().unwrap().starts_with("0.4."));
    let sale = f["sale"].as_str().unwrap();
    // fixture master matches the test master and the independently derived (node HKDF) pubkey matches ours
    assert_eq!(f["master_hex"], hex::encode(MASTER));
    let (pk, _) = keys(sale);
    assert_eq!(hex::encode(pk), f["pubkey_hex"].as_str().unwrap());
    let v = vectors();
    let case = v["clearing_vectors"].as_array().unwrap().iter().find(|c| c["name"] == f["vector"]).unwrap();
    let out = run(&clear_input(case, f["entries"].as_array().unwrap().clone()), &env(sale, after())).unwrap();
    check_against(case, &out, "js fixtures");
    assert!(out["plaintexts"].as_array().unwrap().iter().all(|p| !p.is_null()));
}

#[test]
fn garbage_wrong_sale_and_short_payload_give_none() {
    let f = fixtures();
    let sale = f["sale"].as_str().unwrap();
    let v = vectors();
    let case = v["clearing_vectors"].as_array().unwrap().iter().find(|c| c["name"] == f["vector"]).unwrap();
    let mut entries = f["entries"].as_array().unwrap().clone();
    entries[0]["ciphertext"] = json!("00".repeat(120));                 // garbage
    entries[1]["ciphertext"] = f["wrong_sale_ciphertext"].clone();      // encrypted to another sale's key
    entries[2]["ciphertext"] = f["short_payload_ciphertext"].clone();   // decrypts but 63 bytes
    entries[3]["ciphertext"] = json!("zz-not-hex");
    let out = run(&clear_input(case, entries), &env(sale, after())).unwrap();
    assert!(out["plaintexts"].as_array().unwrap().iter().all(|p| p.is_null()));
    assert_eq!(out["sold"], "0");
    assert_eq!(out["leaf_count"], 0 + 4); // all four deposits refunded -> 4 refund-only leaves
}

#[test]
fn wrong_sale_ciphertext_directly() {
    // ciphertext made for sale B, submitted into sale A's clear: not decryptable
    let a = "sale-a.f.testnet"; let b = "sale-b.f.testnet";
    let v = vectors();
    let case = &v["clearing_vectors"][0];
    let e = &case["entries"][0];
    let mut c = case.clone();
    c["params"]["sale_id"] = json!(a);
    let ct = enc(b, &bid_bytes(&e["plaintext"]));
    let entries = vec![json!({"bidder":e["bidder"],"commit":e["commit"],"deposit":e["deposit"],"ciphertext":ct})];
    let out = run(&clear_input(&c, entries), &env(a, after())).unwrap();
    assert!(out["plaintexts"][0].is_null());
}

fn minimal_clear(sale: &str, bid_end_ms: u64) -> String {
    json!({"action":"clear","params":{"sale_id":sale,"supply":"100","reserve":"1","token_decimals":0,
        "min_size":"0","bid_end_ms":bid_end_ms,"code_hash":CODE_HASH},"entries":[]}).to_string()
}

#[test]
fn guard_clear_accepts_sale_after_bid_end() {
    let s = "sale-g.f.testnet";
    assert!(run(&minimal_clear(s, BID_END_MS), &env(s, after())).is_ok());
    // exactly at bid_end is allowed (>=)
    assert!(run(&minimal_clear(s, BID_END_MS), &env(s, BID_END_MS as u128 * NS)).is_ok());
}

#[test]
fn guard_clear_refuses() {
    let s = "sale-g.f.testnet";
    let err = |e: Env, inp: String| run(&inp, &e).unwrap_err();
    // wrong predecessor: attacker, factory, empty, suffix-lookalike
    for p in ["attacker.testnet", "f.testnet", "", "xsale-g.f.testnet", "sale-g.f.testnet.evil"] {
        let e = err(env(p, after()), minimal_clear(s, BID_END_MS));
        assert!(e.starts_with("refused"), "{p}: {e}");
    }
    // too early: 1 ns before bid_end
    let e = err(env(s, BID_END_MS as u128 * NS - 1), minimal_clear(s, BID_END_MS));
    assert!(e.contains("bidding open"), "{e}");
    // missing / bad / zero timestamp
    for ts in ["", "abc", "0"] {
        let mut en = env(s, 0); en.block_ts_ns = ts.into();
        assert!(err(en, minimal_clear(s, BID_END_MS)).starts_with("refused"));
    }
    // bid_end missing (0) cannot be used to bypass the time lock
    assert!(err(env(s, after()), minimal_clear(s, 0)).contains("bid_end_ms"));
    // ms/ns unit confusion: a timestamp in ms (1.7e12) is far below bid_end in ns and is refused
    assert!(err(env(s, BID_END_MS as u128 + 1), minimal_clear(s, BID_END_MS)).contains("bidding open"));
    // input claims a different sale than the predecessor
    let inp = json!({"action":"clear","sale":"other.f.testnet","params":{"sale_id":s,"supply":"100","reserve":"1",
        "token_decimals":0,"min_size":"0","bid_end_ms":BID_END_MS,"code_hash":CODE_HASH},"entries":[]}).to_string();
    assert!(err(env(s, after()), inp).starts_with("refused"));
}

#[test]
fn guard_refuses_before_any_decryption() {
    // even with an attacker-supplied valid ciphertext, a refused call reveals nothing
    let s = "sale-g.f.testnet";
    let ct = enc(s, &[7u8; 64]);
    let inp = json!({"action":"clear","params":{"sale_id":s,"supply":"100","reserve":"1","token_decimals":0,"min_size":"0",
        "bid_end_ms":BID_END_MS,"code_hash":CODE_HASH},"entries":[{"bidder":"a.t","commit":"00".repeat(32),"deposit":"1","ciphertext":ct}]}).to_string();
    let e = run(&inp, &env("attacker.testnet", after())).unwrap_err();
    assert!(e.starts_with("refused") && !e.contains("0707"));
    // and before bid_end, even from the sale itself
    assert!(run(&inp, &env(s, 1)).unwrap_err().starts_with("refused"));
}

#[test]
fn guard_derive() {
    let s = "sale-g.f.testnet";
    let inp = json!({"action":"derive_pubkey","sale":s}).to_string();
    // sale itself and factory allowed (no timestamp needed)
    let a = run(&inp, &env(s, 0)).unwrap();
    let b = run(&inp, &env("f.testnet", 0)).unwrap();
    assert_eq!(a, b);
    assert_eq!(a["pubkey"].as_str().unwrap().len(), 66);
    // others refused
    for p in ["attacker.testnet", "", "g.f.testnet", "testnet.f.testnet", "sale-g.f.testnet.x"] {
        let e = run(&inp, &env(p, 0)).unwrap_err();
        assert!(e.starts_with("refused"), "{p}: {e}");
    }
    // different sales -> different keys
    let o = run(&json!({"action":"derive_pubkey","sale":"sale-h.f.testnet"}).to_string(), &env("sale-h.f.testnet", 0)).unwrap();
    assert_ne!(a["pubkey"], o["pubkey"]);
}

#[test]
fn bad_action_and_missing_master() {
    assert!(run(r#"{"action":"nope"}"#, &env("x", 0)).is_err());
    let s = "sale-g.f.testnet";
    let mut e = env(s, 0); e.master_hex = String::new();
    assert!(run(&json!({"action":"derive_pubkey","sale":s}).to_string(), &e).unwrap_err().contains("MASTER"));
}
