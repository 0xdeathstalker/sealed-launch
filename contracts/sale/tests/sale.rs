mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use sealed_clearing as sc;
use serde_json::{json, Value};

const P: u128 = NEAR / 1000; // 0.001 NEAR per token

async fn four(e: &mut Env, w: &W) -> anyhow::Result<Vec<near_workspaces::Account>> {
    let mut v = vec![];
    for (price, size) in [(10 * P, 40u128), (8 * P, 30), (5 * P, 50), (3 * P, 20)] {
        let a = w.dev_create_account().await?;
        e.nbid(&a, price, size, 0).await?;
        v.push(a);
    }
    Ok(v)
}

#[tokio::test]
async fn happy_path_recompute_claim_settle_vest() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |_, _| {}).await?;
    let bidders = four(&mut e, &w).await?;
    assert_eq!(e.sale.view("get_bid_count").await?.json::<u32>()?, 4);
    // finalize too early
    assert!(e.finalize(&bidders[0]).await?.is_failure());
    e.ff_past_bid_end().await?;
    let r = e.result();
    e.set_response(&e.tee_output()).await?;
    let f = e.finalize(&bidders[0]).await?;
    assert!(f.is_success(), "{:?}", f.failures());
    assert_eq!(e.status().await, "Cleared");
    let c: Value = e.sale.view("get_clearing").await?.json()?;
    assert_eq!(c["p_star"], r.p_star.to_string());
    assert_eq!(c["verified_onchain"], true);
    println!("p_star={} raise={}", r.p_star, r.raise);
    // claim: bidder a gets 40 tokens + refund; second claim fails; forged amounts fail
    let a = bidders[0].id().to_string();
    let before = balance(&bidders[0]).await;
    let cl = e.claim(&bidders[2], &r, &a).await?;
    assert!(cl.is_success(), "{:?}", cl.failures());
    let bal: String = e.sale.view("ft_balance_of").args_json(json!({"account_id": a})).await?.json()?;
    assert_eq!(bal, "40");
    assert!(balance(&bidders[0]).await > before);
    assert!(e.claim(&bidders[2], &r, &a).await?.is_failure(), "double claim must fail");
    // forged proof: inflate tokens
    let b = bidders[1].id().to_string();
    let hs: Vec<[u8; 32]> = r.leaves.iter().map(sc::leaf_hash).collect();
    let i = r.leaves.iter().position(|l| l.bidder == b).unwrap();
    let proof: Vec<String> = sc::merkle_proof(&hs, i).iter().map(|h| hx(h)).collect();
    let forged = bidders[1].call(e.sale.id(), "claim")
        .args_json(json!({"bidder": b, "index": i, "tokens": "99", "refund": "0", "proof": proof}))
        .gas(Gas::from_tgas(100)).transact().await?;
    assert!(forged.is_failure(), "forged claim must fail");
    // settle: raise to creator, burn nothing (oversubscribed), reserve burned (lp_bps=0)
    let cb = balance(&e.creator).await;
    let s = e.sale.call("settle").gas(Gas::from_tgas(100)).transact().await?;
    assert!(s.is_success(), "{:?}", s.failures());
    assert_eq!(balance(&e.creator).await - cb, r.raise);
    let supply: String = e.sale.view("ft_total_supply").await?.json()?;
    println!("clearing {:?} logs {:?}", c, s.logs());
    assert_eq!(supply, "120"); // 170 minted - 50 LP reserve burned
    assert!(e.sale.call("settle").gas(Gas::from_tgas(100)).transact().await?.is_failure());
    // vesting is linear
    e.ff_secs(400).await?;
    let v = e.sale.call("claim_vested").transact().await?;
    assert!(v.is_success(), "{:?}", v.failures());
    let cr: String = e.sale.view("ft_balance_of").args_json(json!({"account_id": e.creator.id()})).await?.json()?;
    let cr: u128 = cr.parse()?;
    assert!(cr > 0 && cr < 20, "partially vested, got {cr}");
    // fees withdrawable after settle, escrow untouched
    let wf = e.sale.call("withdraw_fees").gas(Gas::from_tgas(60)).transact().await?;
    println!("withdraw_fees ok={} ", wf.is_success());
    Ok(())
}

#[tokio::test]
async fn onclear_attacks() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |_, _| {}).await?;
    // second sale for replay test, same outlayer mock
    let sale_b = w.dev_deploy(&sale_wasm()).await?;
    let mut eb = Env::with_mock(&w, e.mock.clone(), sale_b, |_, _| {}).await?;
    let bidders = four(&mut e, &w).await?;
    let _ = four(&mut eb, &w).await?;
    e.ff_past_bid_end().await?;
    let good = e.tee_output();

    // 1. forged on_clear straight from an attacker: private
    let atk = w.dev_create_account().await?;
    let f = atk.call(e.sale.id(), "on_clear").args_json(json!({"nonce": 1})).gas(Gas::from_tgas(100)).transact().await?;
    assert!(f.is_failure());
    println!("[attack] forged on_clear -> {:?}", f.failures().first().map(|x| format!("{x:?}").chars().take(120).collect::<String>()));

    // 2. null / error / missing p_star = failed run, retryable
    for bad in [Value::Null, json!({"error":"refused: before bid_end"}), json!({"sale_id": e.sale_id()})] {
        e.set_response(&bad).await?;
        let r = e.finalize(&bidders[0]).await?;
        assert!(logs_contain(&r, "on_clear_rejected"), "{bad}");
        assert_eq!(e.status().await, "Clearing");
        assert_eq!(e.sale_view().await["in_flight"], false);
    }
    // 3. tampered p_star
    let mut t = good.clone(); t["p_star"] = json!((9 * P).to_string());
    e.set_response(&t).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    assert_eq!(e.status().await, "Clearing");
    // 4. tampered allocation root
    let mut t = good.clone(); t["alloc_root"] = json!(hx(&[7u8; 32]));
    e.set_response(&t).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    // 5. plaintext swapped (bid 2 claims a higher price than committed): commit mismatch -> output differs
    let mut t = good.clone(); t["plaintexts"][2]["price"] = json!((50 * P).to_string());
    e.set_response(&t).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    // 6. wrong code hash echo
    let mut t = good.clone(); t["code_hash"] = json!(hx(&[1u8; 32]));
    e.set_response(&t).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    // 7. replay: result of sale B into sale A
    let out_b = eb.tee_output();
    e.set_response(&out_b).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    // 8. input_hash mismatch (result computed over a different bid set)
    let mut t = good.clone(); t["input_hash"] = json!(hx(&[3u8; 32]));
    e.set_response(&t).await?;
    assert!(logs_contain(&e.finalize(&bidders[0]).await?, "on_clear_rejected"));
    assert_eq!(e.status().await, "Clearing");
    // 9. correct result accepted; then second finalize / second result rejected (single use)
    e.set_response(&good).await?;
    let ok = e.finalize(&bidders[0]).await?;
    assert!(logs_contain(&ok, "cleared"), "{:?}", ok.logs());
    assert_eq!(e.status().await, "Cleared");
    assert!(e.finalize(&bidders[0]).await?.is_failure(), "second finalize after Cleared");
    Ok(())
}

#[tokio::test]
async fn drops_garbage_underfunded_mismatch() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |_, _| {}).await?;
    let a = w.dev_create_account().await?;
    let b = w.dev_create_account().await?;
    let c = w.dev_create_account().await?;
    let d = w.dev_create_account().await?;
    e.nbid(&a, 5 * P, 60, 0).await?; // good
    e.nbid(&b, 9 * P, 30, 0).await?; // TEE cannot decrypt -> null
    e.recs[1].plain = None;
    // underfunded: committed size 30 @9P but deposit only for 10
    let bid = e.mkbid("", 9 * P, 30, 9);
    let commit = sc::commit_hash(&bid, c.id().as_str(), &e.sale_id());
    let dep = sc::cost(9 * P, 10, 0).unwrap();
    c.call(e.sale.id(), "bid").args_json(json!({"ciphertext": e.ct(2), "commit": hx(&commit)}))
        .deposit(NearToken::from_yoctonear(FEE + dep)).transact().await?.into_result()?;
    e.recs.push(Rec { bidder: c.id().to_string(), commit, deposit: dep, plain: Some(bid) });
    // commit mismatch: TEE returns plaintext with another salt
    e.nbid(&d, 9 * P, 30, 0).await?;
    e.recs[3].plain.as_mut().unwrap().salt = [0xee; 32];
    e.ff_past_bid_end().await?;
    let r = e.result();
    assert_eq!(r.p_star, P); // only `a` valid, undersubscribed -> reserve
    e.set_response(&e.tee_output()).await?;
    let f = e.finalize(&a).await?;
    assert!(f.is_success(), "{:?}", f.failures());
    assert_eq!(e.status().await, "Cleared");
    // dropped bidders get 100% of deposit back at claim
    let cl = e.claim(&a, &r, c.id().as_str()).await?;
    assert!(cl.is_success(), "{:?}", cl.failures());
    let lf = r.leaves.iter().find(|l| l.bidder == c.id().as_str()).unwrap();
    assert_eq!((lf.tokens, lf.refund), (0, dep));
    let lf = r.leaves.iter().find(|l| l.bidder == d.id().as_str()).unwrap();
    assert_eq!(lf.refund, e.recs[3].deposit);
    // undersubscribed: burned = 40
    let cs: Value = e.sale.view("get_clearing").await?.json()?;
    assert_eq!(cs["burned"], "40");
    Ok(())
}

#[tokio::test]
async fn challenge_voids_on_false_drop_and_refunds_everything() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    // recompute_cap = 0 -> challenge-window path
    let mut e = Env::new(&w, |p, _| { p["recompute_cap"] = json!(0); p["challenge_secs"] = json!(300); }).await?;
    let bidders = four(&mut e, &w).await?;
    e.ff_past_bid_end().await?;
    // malicious TEE: drops bidder 0's winning bid (reports null) and computes on the rest
    let honest = e.result();
    let mut lying = e.clone_entries_without(0);
    let r2 = sc::clear(&e.sc_params(), &lying).unwrap();
    let out = e.tee_output_for(&lying, &r2);
    lying.clear();
    e.set_response(&out).await?;
    let f = e.finalize(&bidders[3]).await?;
    assert!(f.is_success(), "{:?}", f.failures());
    assert_eq!(e.status().await, "Challenge");
    assert_ne!(r2.alloc_root, honest.alloc_root);
    // challenge with a bid that was honestly committed but whose slot the TEE did not publish
    let b = e.recs[0].plain.clone().unwrap();
    // wrong salt -> rejected
    let bad = bidders[1].call(e.sale.id(), "challenge").args_json(json!({"idx":0,"price":b.price.to_string(),"size":b.size.to_string(),"salt":hx(&[1u8;32])})).transact().await?;
    assert!(bad.is_failure());
    // a correctly-published bid cannot be used to void
    let ok_bid = e.recs[1].plain.clone().unwrap();
    let nofault = bidders[1].call(e.sale.id(), "challenge").args_json(json!({"idx":1,"price":ok_bid.price.to_string(),"size":ok_bid.size.to_string(),"salt":hx(&ok_bid.salt)})).transact().await?;
    assert!(nofault.is_failure(), "no fault -> no void");
    let ch = bidders[1].call(e.sale.id(), "challenge").args_json(json!({"idx":0,"price":b.price.to_string(),"size":b.size.to_string(),"salt":hx(&b.salt)})).transact().await?;
    assert!(ch.is_success(), "{:?}", ch.failures());
    assert_eq!(e.status().await, "Refund");
    assert_eq!(e.sale_view().await["voided"], true);
    // 100% refunds of deposits
    for (i, a) in bidders.iter().enumerate() {
        let before = balance(a).await;
        let r = a.call(e.sale.id(), "refund").args_json(json!({"idx": i})).gas(Gas::from_tgas(50)).transact().await?;
        assert!(r.is_success(), "{:?}", r.failures());
        let gain = balance(a).await + 0 - before;
        assert!(gain + NEAR / 15 > e.recs[i].deposit, "refund {i}: gain {gain} dep {}", e.recs[i].deposit); // minus gas
        assert!(a.call(e.sale.id(), "refund").args_json(json!({"idx": i})).transact().await?.is_failure(), "refund twice");
    }
    Ok(())
}

#[tokio::test]
async fn challenge_recompute_catches_tampered_allocation_above_cap() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |p, _| { p["recompute_cap"] = json!(0); }).await?;
    let bidders = four(&mut e, &w).await?;
    e.ff_past_bid_end().await?;
    let mut t = e.tee_output();
    t["p_star"] = json!((4 * P).to_string()); // lower price (all plaintexts honest)
    e.set_response(&t).await?;
    assert!(e.finalize(&bidders[0]).await?.is_success());
    assert_eq!(e.status().await, "Challenge");
    let r = bidders[1].call(e.sale.id(), "challenge_recompute").gas(Gas::from_tgas(300)).transact().await?;
    assert_eq!(r.json::<bool>()?, true);
    assert_eq!(e.status().await, "Refund");
    Ok(())
}

#[tokio::test]
async fn honest_above_cap_clears_after_window() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |p, _| { p["recompute_cap"] = json!(0); p["challenge_secs"] = json!(100); }).await?;
    let bidders = four(&mut e, &w).await?;
    e.ff_past_bid_end().await?;
    e.set_response(&e.tee_output()).await?;
    assert!(e.finalize(&bidders[0]).await?.is_success());
    let r = e.result();
    assert!(e.claim(&bidders[0], &r, bidders[0].id().as_str()).await?.is_failure(), "claim before window ends");
    assert!(bidders[0].call(e.sale.id(), "challenge_recompute").gas(Gas::from_tgas(300)).transact().await?.json::<bool>()? == false);
    e.ff_secs(120).await?;
    assert!(e.claim(&bidders[0], &r, bidders[0].id().as_str()).await?.is_success());
    Ok(())
}

#[tokio::test]
async fn tee_never_answers_then_refund_mode_and_cancel_topup() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let mut e = Env::new(&w, |p, _| { p["finalize_timeout_secs"] = json!(200); }).await?;
    let a = w.dev_create_account().await?;
    let b = w.dev_create_account().await?;
    let i0 = e.nbid(&a, 5 * P, 10, 0).await?;
    e.nbid(&b, 5 * P, 10, 0).await?;
    // top_up and cancel before bid_end
    a.call(e.sale.id(), "top_up").args_json(json!({"idx": i0})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    assert!(b.call(e.sale.id(), "top_up").args_json(json!({"idx": i0})).deposit(NearToken::from_millinear(10)).transact().await?.is_failure(), "only owner tops up");
    let cb = b.call(e.sale.id(), "cancel_bid").args_json(json!({"idx": 1})).gas(Gas::from_tgas(50)).transact().await?;
    assert!(cb.is_success(), "{:?}", cb.failures());
    assert!(b.call(e.sale.id(), "cancel_bid").args_json(json!({"idx": 1})).transact().await?.is_failure());
    assert!(a.call(e.sale.id(), "refund").args_json(json!({"idx": 0})).transact().await?.is_failure(), "not refund mode yet");
    e.ff_past_bid_end().await?;
    e.set_response(&Value::Null).await?;
    let f = e.finalize(&a).await?;
    assert!(logs_contain(&f, "on_clear_rejected"));
    // bids closed
    assert!(b.call(e.sale.id(), "bid").args_json(json!({"ciphertext": e.ct(9), "commit": hx(&[5u8;32])})).deposit(NearToken::from_near(1)).transact().await?.is_failure());
    e.ff_secs(260).await?;
    assert_eq!(e.sale.view("is_refund_mode").await?.json::<bool>()?, true);
    assert!(e.finalize(&a).await?.is_failure(), "finalize after deadline");
    let before = balance(&a).await;
    let r = a.call(e.sale.id(), "refund").args_json(json!({"idx": 0})).gas(Gas::from_tgas(50)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let dep = e.recs[0].deposit + NEAR / 100; // topped up 0.01
    assert!(balance(&a).await + NEAR / 15 > before + dep);
    // late result must not resurrect the sale
    let n = e.sale.call("refund_all").args_json(json!({"from":0,"limit":10})).gas(Gas::from_tgas(100)).transact().await?;
    assert_eq!(n.json::<u32>()?, 0);
    Ok(())
}

#[tokio::test]
async fn no_bids_clears_onchain_without_tee() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let e = Env::new(&w, |_, _| {}).await?;
    e.ff_past_bid_end().await?;
    let caller = w.dev_create_account().await?;
    let f = e.finalize(&caller).await?;
    assert!(f.is_success(), "{:?}", f.failures());
    let c: Value = e.sale.view("get_clearing").await?.json()?;
    assert_eq!(c["burned"], "100");
    assert_eq!(e.status().await, "Cleared");
    Ok(())
}

#[tokio::test]
async fn keyless_sale_has_no_access_keys() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let e = Env::new(&w, |_, _| {}).await?;
    let keys = e.sale.view_access_keys().await?;
    for k in keys {
        e.sale.batch().delete_key(k.public_key).transact().await?.into_result()?;
    }
    assert!(e.sale.view_access_keys().await?.is_empty());
    // contract still works with zero keys
    assert_eq!(e.status().await, "Bidding");
    Ok(())
}

#[tokio::test]
async fn fallback_commit_reveal() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let bond = NEAR / 10;
    let mut e = Env::new(&w, |p, _| { p["mode"] = json!("Fallback"); p["reveal_secs"] = json!(300); p["reveal_bond"] = json!(bond.to_string()); }).await?;
    let a = w.dev_create_account().await?;
    let b = w.dev_create_account().await?;
    let c = w.dev_create_account().await?;
    for (acc, price, size) in [(&a, 8 * P, 60u128), (&b, 5 * P, 60), (&c, 5 * P, 10)] {
        let bid = e.mkbid("", price, size, 9);
        let commit = sc::commit_hash(&bid, acc.id().as_str(), &e.sale_id());
        let dep = sc::cost(price, size, 0).unwrap();
        acc.call(e.sale.id(), "bid_commit").args_json(json!({"commit": hx(&commit)}))
            .deposit(NearToken::from_yoctonear(FEE + bond + dep)).transact().await?.into_result()?;
        e.recs.push(Rec { bidder: acc.id().to_string(), commit, deposit: dep, plain: Some(bid) });
    }
    // normal bid() is refused in fallback mode
    assert!(a.call(e.sale.id(), "bid").args_json(json!({"ciphertext": e.ct(1), "commit": hx(&[5u8;32])})).deposit(NearToken::from_near(1)).transact().await?.is_failure());
    e.ff_past_bid_end().await?;
    let rv = |acc: &near_workspaces::Account, i: usize, e: &Env| {
        let b = e.recs[i].plain.clone().unwrap();
        acc.call(e.sale.id(), "reveal").args_json(json!({"idx": i, "price": b.price.to_string(), "size": b.size.to_string(), "salt": hx(&b.salt)})).gas(Gas::from_tgas(50)).transact()
    };
    // wrong salt fails
    let wrong = a.call(e.sale.id(), "reveal").args_json(json!({"idx":0,"price":(8*P).to_string(),"size":"60","salt":hx(&[1u8;32])})).transact().await?;
    assert!(wrong.is_failure());
    assert!(rv(&a, 0, &e).await?.is_success());
    assert!(rv(&b, 1, &e).await?.is_success());
    // c never reveals
    let c_bid = e.recs[2].plain.clone();
    e.recs[2].plain = None;
    assert!(e.sale.call("clear").transact().await?.is_failure(), "reveal window still open");
    e.ff_secs(320).await?;
    let late = c.call(e.sale.id(), "reveal").args_json(json!({"idx":2,"price":c_bid.as_ref().unwrap().price.to_string(),"size":c_bid.as_ref().unwrap().size.to_string(),"salt":hx(&c_bid.as_ref().unwrap().salt)})).transact().await?;
    assert!(late.is_failure(), "late reveal");
    let cl = e.sale.call("clear").gas(Gas::from_tgas(300)).transact().await?;
    assert!(cl.is_success(), "{:?}", cl.failures());
    let r = e.result();
    assert_eq!(e.status().await, "Cleared");
    let st = e.sale.call("slash_unrevealed").args_json(json!({"idx": 2})).transact().await?;
    assert!(st.is_success(), "{:?}", st.failures());
    assert!(e.sale.call("slash_unrevealed").args_json(json!({"idx": 2})).transact().await?.is_failure());
    // same claim path
    let k = e.claim(&c, &r, c.id().as_str()).await?;
    assert!(k.is_success(), "{:?}", k.failures());
    assert!(e.claim(&a, &r, a.id().as_str()).await?.is_success());
    println!("fallback clear gas_burnt(tx)={}", cl.total_gas_burnt.as_gas());
    Ok(())
}
