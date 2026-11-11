mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use sealed_clearing as sc;
use serde_json::{json, Value};

const P: u128 = NEAR / 1000;

fn ft_msg(sale: &str, ct: &str, commit: &[u8; 32], bidder: Option<&str>, refund_to: Option<&str>) -> Value {
    json!({"v":1,"sale_id":sale,"ciphertext":ct,"commit":hx(commit),"bidder":bidder,"refund_to":refund_to})
}

async fn fake(e: &Env, bids: Vec<(String, u128, String)>) -> anyhow::Result<()> {
    let arr: Vec<Value> = bids.into_iter().map(|(s, a, m)| json!({"sender": s, "amount": a.to_string(), "msg": m})).collect();
    e.mock.call("fake_bids").args_json(json!({"sale": e.sale.id(), "bids": arr})).gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn intents_style_ft_path_never_rejects_and_unclaimed_pull() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |p, mock| { p["payment_token"] = json!(mock); }).await?;
    let sale = e.sale_id();
    let relayer = w.dev_create_account().await?; // plays the Intents contract as sender_id
    let rel = relayer.id().to_string();
    let alice = "alice.test.near";
    // good bid, base64url msg, bidder != sender
    let bid = e.mkbid("", 5 * P, 40, 9);
    let commit = sc::commit_hash(&bid, alice, &sale);
    let dep = sc::cost(bid.price, bid.size, 0).unwrap();
    let m = ft_msg(&sale, &e.ct(0), &commit, Some(alice), None).to_string();
    let m64 = b64url(m.as_bytes());
    assert!(m64.len() <= 1024);
    // malformed, wrong sale, duplicate commit, huge msg, bad bidder, below-fee
    let bid2 = e.mkbid("", 6 * P, 10, 7);
    let c2 = sc::commit_hash(&bid2, "bob.test.near", &sale);
    let bid_a = (rel.clone(), FEE + dep, m64.clone());
    let bad = vec![
        bid_a,
        (rel.clone(), 5 * NEAR, "not json".to_string()),
        (rel.clone(), 5 * NEAR, ft_msg("other.test.near", &e.ct(1), &c2, Some("bob.test.near"), None).to_string()),
        (rel.clone(), 5 * NEAR, m64.clone()), // duplicate commit -> unclaimed
        (rel.clone(), 5 * NEAR, "x".repeat(2000)),
        (rel.clone(), 5 * NEAR, ft_msg(&sale, &e.ct(1), &c2, Some("NOT A NEAR ACCOUNT"), None).to_string()),
        (rel.clone(), FEE, ft_msg(&sale, &e.ct(1), &c2, Some("bob.test.near"), None).to_string()), // amount == fee
    ];
    fake(&e, bad).await?;
    e.recs.push(Rec { bidder: alice.into(), commit, deposit: dep, plain: Some(bid) });
    assert_eq!(e.sale.view("get_bid_count").await?.json::<u32>()?, 1, "only the good bid is a slot");
    let st: Value = e.sale.view("bid_status").args_json(json!({"commit": hx(&commit)})).await?.json()?;
    assert_eq!(st["state"], "accepted");
    let st: Value = e.sale.view("bid_status").args_json(json!({"commit": hx(&c2)})).await?.json()?;
    assert_eq!(st["state"], "unclaimed", "{st}");
    // non-allowlisted token: returned in full, no state change (called directly by a random account)
    let rnd = w.dev_create_account().await?;
    let r = rnd.call(e.sale.id(), "ft_on_transfer").args_json(json!({"sender_id": rel, "amount":"123", "msg":"{}"})).transact().await?;
    assert_eq!(r.json::<String>()?, "123");
    // unclaimed pull: sender-only when msg names no NEAR account
    let bm = "not json".to_string();
    let none = rnd.call(e.sale.id(), "claim_refund").args_json(json!({"sender_id": rel, "token": e.mock.id(), "raw_msg": bm, "to": null})).transact().await?;
    assert!(none.is_failure(), "stranger cannot pull sender's malformed-msg funds");
    let ok = relayer.call(e.sale.id(), "claim_refund").args_json(json!({"sender_id": rel, "token": e.mock.id(), "raw_msg": bm, "to": null})).gas(Gas::from_tgas(60)).transact().await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    let calls: Vec<String> = e.mock.view("get_calls").await?.json()?;
    assert!(calls.iter().any(|c| c == &format!("ft_transfer {} {}", rel, 5 * NEAR)), "{calls:?}");
    assert!(relayer.call(e.sale.id(), "claim_refund").args_json(json!({"sender_id": rel, "token": e.mock.id(), "raw_msg": bm, "to": null})).transact().await?.is_failure(), "pull once");
    // late transfer -> unclaimed, refundable to the NEAR account named in msg (by anyone)
    e.ff_past_bid_end().await?;
    let late_m = ft_msg(&sale, &e.ct(2), &[9u8; 32], Some(rnd.id().as_str()), None).to_string();
    fake(&e, vec![(rel.clone(), 3 * NEAR, late_m.clone())]).await?;
    assert_eq!(e.sale.view("get_bid_count").await?.json::<u32>()?, 1);
    let pull = w.dev_create_account().await?;
    let ok = pull.call(e.sale.id(), "claim_refund").args_json(json!({"sender_id": rel, "token": e.mock.id(), "raw_msg": late_m, "to": null})).gas(Gas::from_tgas(60)).transact().await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    let calls: Vec<String> = e.mock.view("get_calls").await?.json()?;
    assert!(calls.iter().any(|c| c == &format!("ft_transfer {} {}", rnd.id(), 3 * NEAR)), "{calls:?}");
    // clearing + claim over the FT payment token path
    e.set_response(&e.tee_output()).await?;
    let f = e.finalize(&pull).await?;
    assert!(f.is_success(), "{:?}", f.failures());
    assert_eq!(e.status().await, "Cleared");
    let r = e.result();
    let k = e.claim(&pull, &r, alice).await?;
    assert!(k.is_success(), "{:?}", k.failures());
    let calls: Vec<String> = e.mock.view("get_calls").await?.json()?;
    assert!(calls.iter().any(|c| c.starts_with(&format!("ft_transfer {alice}"))), "refund over ft: {calls:?}");
    Ok(())
}

#[tokio::test]
async fn settle_with_ref_lp_against_mocks() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let rf = w.dev_deploy(&mock_wasm()).await?;
    let wn = w.dev_deploy(&mock_wasm()).await?;
    let (rfid, wnid) = (rf.id().to_string(), wn.id().to_string());
    let mut e = Env::new(&w, |p, _| { p["lp_bps"] = json!(5000); p["ref_exchange"] = json!(rfid); p["wnear"] = json!(wnid); }).await?;
    let mut bs = vec![];
    for (price, size) in [(10 * P, 40u128), (8 * P, 30), (5 * P, 50), (3 * P, 20)] {
        let a = w.dev_create_account().await?;
        e.nbid(&a, price, size, 0).await?;
        bs.push(a);
    }
    e.ff_past_bid_end().await?;
    e.set_response(&e.tee_output()).await?;
    assert!(e.finalize(&bs[0]).await?.is_success());
    let r = e.result();
    let cb = balance(&e.creator).await;
    let s = e.sale.call("settle").gas(Gas::from_tgas(300)).transact().await?;
    assert!(s.is_success(), "{:?}", s.failures());
    let lp_funds = r.raise / 2;
    let lp_tokens = lp_funds / r.p_star; // D=0
    assert!(s.outcomes().iter().all(|o| !o.is_failure()), "a receipt failed");
    let info = e.sale_view().await;
    assert_eq!(info["lp_status"], "Done", "{info}");
    assert_eq!(balance(&e.creator).await - cb, r.raise - lp_funds);
    let rc: Vec<String> = rf.view("get_calls").await?.json()?;
    let wc: Vec<String> = wn.view("get_calls").await?.json()?;
    println!("ref calls {rc:#?}\nwnear calls {wc:#?}");
    assert!(wc.iter().any(|c| c == &format!("near_deposit {lp_funds}")));
    assert!(rc.iter().any(|c| c.starts_with("add_simple_pool")));
    assert!(rc.iter().any(|c| c.starts_with("add_liquidity 7")));
    assert!(rc.iter().any(|c| c.starts_with("ft_on_transfer")), "Ref received the sale token");
    // pool opens at exactly p_star: funds == tokens * p_star (D=0, so no rounding slack)
    let al = rc.iter().find(|c| c.starts_with("add_liquidity 7")).unwrap();
    let nums: Vec<u128> = al.replace("U128", "").split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).skip(1).map(|x| x.parse().unwrap()).collect();
    let mut amts = nums.clone();
    amts.sort();
    assert_eq!(amts.len(), 2, "{al}");
    let (tok, fun) = if amts[0] == lp_tokens { (amts[0], amts[1]) } else { (amts[1], amts[0]) };
    assert_eq!(tok, lp_tokens);
    assert_eq!(fun, tok * r.p_star, "pool price must equal p_star: {al}");
    assert!(fun <= lp_funds && lp_funds - fun < r.p_star, "remainder < one token");
    // unused LP reserve burned: 50 reserve - lp_tokens
    let supply: String = e.sale.view("ft_total_supply").await?.json()?;
    assert_eq!(supply.parse::<u128>()?, 170 - (50 - lp_tokens));
    Ok(())
}

async fn bench(n: usize, cap: u32) -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let e = bulk_env(&w, n, cap).await?;
    let caller = w.dev_create_account().await?;
    e.set_response(&e.tee_output()).await?;
    let need: u64 = e.sale.view("finalize_gas_needed").await?.json::<String>()?.parse()?;
    let f = e.finalize(&caller).await?;
    let used = f.logs().iter().find_map(|l| l.strip_prefix("on_clear_used_gas=").map(|x| x.parse::<u64>().unwrap()));
    println!("BENCH n={n} cap={cap} success={} status={} finalize_gas_needed={:.0}T on_clear_used_gas={:?}T tx_total_gas_burnt={:.1}T",
        f.is_success(), e.status().await, need as f64 / 1e12, used.map(|u| u as f64 / 1e12), f.total_gas_burnt.as_gas() as f64 / 1e12);
    for o in f.outcomes() {
        println!("   receipt {} gas_burnt={:.2}T", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12);
    }
    println!("   rejected_logs: {:?}", f.logs().iter().filter(|l| l.contains("rejected")).collect::<Vec<_>>());
    if cap == 0 {
        let c = caller.call(e.sale.id(), "challenge_recompute").gas(Gas::from_tgas(300)).transact().await?;
        println!("BENCH n={n} challenge_recompute tx gas_burnt={:.1}T voided={:?} ok={}", c.total_gas_burnt.as_gas() as f64 / 1e12, c.clone().json::<bool>().ok(), c.is_success());
    }
    let _ = NearToken::from_near(0);
    Ok(())
}

/// Sale with `n` NEP-141 bids placed through the mock token, fast-forwarded past bid_end.
async fn bulk_env(w: &W, n: usize, cap: u32) -> anyhow::Result<Env> {
    let mut e = Env::new(w, |p, mock| {
        p["payment_token"] = json!(mock);
        p["recompute_cap"] = json!(cap);
        p["auction_supply"] = json!((n * 3).to_string());
        p["max_bids"] = json!(1000);
        p["bid_end_ms"] = json!((chain_ms_blocking() + 600_000).to_string());
    }).await?;
    let sale = e.sale_id();
    let mut batch = vec![];
    for i in 0..n {
        let price = (1 + (i as u128 * 7) % 37) * P;
        let size = 1 + (i as u128 * 5) % 9;
        let who = format!("b{i}.test.near");
        let bid = e.mkbid("", price, size, 9);
        let commit = sc::commit_hash(&bid, &who, &sale);
        let dep = sc::cost(price, size, 0).unwrap() + (i as u128 % 3) * P;
        let m = ft_msg(&sale, &e.ct(i), &commit, Some(&who), None).to_string();
        e.recs.push(Rec { bidder: who, commit, deposit: dep, plain: Some(bid) });
        batch.push((e.mock.id().to_string(), FEE + dep, m));
        if batch.len() == 15 {
            fake(&e, std::mem::take(&mut batch)).await?;
        }
    }
    if !batch.is_empty() { fake(&e, batch).await?; }
    assert_eq!(e.sale.view("get_bid_count").await?.json::<u32>()? as usize, n);
    e.ff_past_bid_end().await?;
    Ok(e)
}

/// The 100-bid live failure: a flat 0.1 NEAR is below OutLayer's floor once input_data passes 32 KiB.
/// The sale now rejects it itself (state untouched, caller keeps the NEAR) and the view's amount works.
#[tokio::test]
async fn finalize_deposit_sized_from_input() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let e = bulk_env(&w, 100, 200).await?;
    let d = e.finalize_deposit(None).await?;
    let req: u128 = d["required"].as_str().unwrap().parse()?;
    let rec: u128 = d["recommended"].as_str().unwrap().parse()?;
    let len = d["input_len"].as_u64().unwrap();
    println!("n=100 input_len={len} required={req} recommended={rec}");
    assert_eq!(d["exact"], true);
    assert_eq!(d["bid_count"], 100);
    assert!(len > 32_768, "100 bids exceed the free 32 KiB");
    // same formula as OutLayer: 0.0070005 compute (5e9 instr, 60 s) + 1e-5 NEAR per byte over 32 KiB
    assert_eq!(req, 7_000_500_000_000_000_000_000 + (len as u128 - 32_768) * 10_000_000_000_000_000_000);
    assert!(req > NEAR / 10 && rec > req && rec <= req + req * 3 / 10 + NEAR / 1000);
    // the planning estimate grows with bid count
    let est = |v: Value| v["required"].as_str().unwrap().parse::<u128>().unwrap();
    let (e10, e100, e200) = (est(e.finalize_deposit(Some(10)).await?), est(e.finalize_deposit(Some(100)).await?), est(e.finalize_deposit(Some(200)).await?));
    assert!(e10 < e100 && e100 < e200, "{e10} {e100} {e200}");

    let caller = w.dev_create_account().await?;
    e.set_response(&e.tee_output()).await?;
    let ol_calls = || async { e.mock.view("get_calls").await.unwrap().json::<Vec<String>>().unwrap().iter().filter(|c| *c == "request_execution").count() };
    let before = ol_calls().await;
    // (panic text is not surfaced by this wasm build: it shows as an `unreachable` trap, so check effects)
    let bad = e.finalize_with(&caller, NEAR / 10).await?;
    assert!(bad.is_failure());
    let bad = e.finalize_with(&caller, req - 1).await?;
    assert!(bad.is_failure());
    assert_eq!(ol_calls().await, before, "rejected in the sale, OutLayer never called");
    let info = e.sale_view().await;
    assert_eq!(info["status"], "Bidding");
    assert_eq!(info["in_flight"], false);
    let ok = e.finalize_with(&caller, req).await?;
    assert!(ok.is_success(), "{:?}", ok.failures());
    assert_eq!(e.status().await, "Cleared");
    Ok(())
}

fn chain_ms_blocking() -> u64 {
    // closure above runs before any block read; sandbox genesis time ~ wall clock
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test]
async fn bench_recompute_50() -> anyhow::Result<()> { bench(50, 200).await }
#[tokio::test]
async fn bench_recompute_100() -> anyhow::Result<()> { bench(100, 200).await }
#[tokio::test]
async fn bench_recompute_200() -> anyhow::Result<()> { bench(200, 200).await }
#[tokio::test]
async fn bench_store_only_200() -> anyhow::Result<()> { bench(200, 0).await }


#[tokio::test]
async fn init_rejects_lp_reserve_too_small_and_bids_carry_ts() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    // auction_supply 100, lp_bps 5000 -> reserve must be >= 50; common params use reserve 50
    let rf = w.dev_deploy(&mock_wasm()).await?;
    let wn = w.dev_deploy(&mock_wasm()).await?;
    let (rfid, wnid) = (rf.id().to_string(), wn.id().to_string());
    let bad = Env::new(&w, |p, _| { p["lp_bps"] = json!(5000); p["lp_token_reserve"] = json!("49"); p["ref_exchange"] = json!(rfid); p["wnear"] = json!(wnid); }).await;
    assert!(bad.is_err(), "reserve 49 < 50 must be rejected at init");
    let mut e = Env::new(&w, |p, _| { p["lp_bps"] = json!(5000); p["ref_exchange"] = json!(rfid); p["wnear"] = json!(wnid); }).await?;
    let a = w.dev_create_account().await?;
    let before = chain_ms_blocking();
    e.nbid(&a, 10 * P, 40, 0).await?;
    let b: serde_json::Value = e.sale.view("get_bid").args_json(json!({"idx":0})).await?.json()?;
    let ts: u64 = b["ts"].as_str().unwrap().parse()?;
    assert!(ts >= before && ts < before + 600_000, "ts {ts} vs {before}");
    Ok(())
}
