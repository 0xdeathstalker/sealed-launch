#![allow(dead_code)]
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use sealed_clearing as sc;
use serde_json::{json, Value};

pub type W = Worker<near_workspaces::network::Sandbox>;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const FEE: u128 = NEAR / 100;
pub const CODE_HASH: &str = "607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6";

pub fn hx(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn b64url(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(A[(n >> 18) as usize & 63] as char);
        s.push(A[(n >> 12) as usize & 63] as char);
        if c.len() > 1 { s.push(A[(n >> 6) as usize & 63] as char); }
        if c.len() > 2 { s.push(A[n as usize & 63] as char); }
    }
    s
}

pub fn sale_wasm() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/target/wasm32-unknown-unknown/release/sealed_sale.wasm"))
        .expect("build the sale wasm first: cargo build --target wasm32-unknown-unknown --release")
}
pub fn mock_wasm() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/mock-outlayer/target/wasm32-unknown-unknown/release/mock_outlayer.wasm"))
        .expect("build mock-outlayer first")
}

#[derive(Clone)]
pub struct Rec {
    pub bidder: String,
    pub commit: [u8; 32],
    pub deposit: u128,
    pub plain: Option<sc::Bid>,
}

pub struct Env {
    pub w: W,
    pub sale: Contract,
    pub mock: Contract,
    pub creator: Account,
    pub recs: Vec<Rec>,
    pub params: Value,
}

pub async fn chain_ms(w: &W) -> u64 {
    w.view_block().await.unwrap().timestamp() / 1_000_000
}

pub fn default_params(creator: &str, factory: &str, outlayer: &str, bid_end_ms: u64) -> Value {
    json!({
        "symbol":"SL","token_name":"SealedLaunch Test","icon":null,"token_decimals":0,
        "auction_supply":"100","lp_token_reserve":"50","creator_supply":"20",
        "reserve_price": (NEAR/1000).to_string(), "min_size":"1","bid_fee": FEE.to_string(),
        "payment_token":null,"bid_end_ms": bid_end_ms.to_string(),"challenge_secs":300,"lp_bps":0,"vesting_secs":1000,
        "outlayer_project":"deathstalker-sl.testnet/sealedlaunch","code_hash":CODE_HASH,"max_bids":500,
        "creator":creator,"factory":factory,"outlayer":outlayer,
        "finalize_timeout_secs":900,"recompute_cap":200,"mode":null,"reveal_secs":0,"reveal_bond":"0",
        "pubkey":null,"ref_exchange":null,"wnear":null
    })
}

impl Env {
    /// `edit` mutates the init params before deployment.
    pub async fn new(w: &W, edit: impl FnOnce(&mut Value, &str)) -> anyhow::Result<Env> {
        let mock = w.dev_deploy(&mock_wasm()).await?;
        let sale = w.dev_deploy(&sale_wasm()).await?;
        Self::with_mock(w, mock, sale, edit).await
    }
    pub async fn with_mock(w: &W, mock: Contract, sale: Contract, edit: impl FnOnce(&mut Value, &str)) -> anyhow::Result<Env> {
        let creator = w.dev_create_account().await?;
        let now = chain_ms(w).await;
        let mut p = default_params(creator.id().as_str(), "factory.test.near", mock.id().as_str(), now + 120_000);
        edit(&mut p, mock.id().as_str());
        sale.call("new").args_json(json!({"p": p})).transact().await?.into_result()?;
        Ok(Env { w: w.clone(), sale, mock, creator, recs: vec![], params: p })
    }
    pub fn dec(&self) -> u8 { self.params["token_decimals"].as_u64().unwrap() as u8 }
    pub fn sale_id(&self) -> String { self.sale.id().to_string() }
    pub fn sc_params(&self) -> sc::Params {
        let g = |k: &str| self.params[k].as_str().unwrap().parse::<u128>().unwrap();
        sc::Params { sale_id: self.sale_id(), supply: g("auction_supply"), reserve: g("reserve_price"), token_decimals: self.dec(), min_size: g("min_size") }
    }
    pub fn mkbid(&self, who: &str, price: u128, size: u128, tag: u8) -> sc::Bid {
        let _ = who;
        let mut salt = [tag; 32];
        salt[0] = (self.recs.len() & 255) as u8;
        salt[1] = (self.recs.len() >> 8) as u8;
        sc::Bid { price, size, salt }
    }
    pub fn ct(&self, i: usize) -> String {
        let mut v = vec![0u8; 161];
        for (k, b) in v.iter_mut().enumerate() { *b = ((i * 31 + k * 7) & 255) as u8; }
        hx(&v)
    }

    /// NEAR bid; deposit = cost + extra. Returns slot idx (records locally).
    pub async fn nbid(&mut self, who: &Account, price: u128, size: u128, extra: u128) -> anyhow::Result<usize> {
        let bid = self.mkbid(who.id().as_str(), price, size, 9);
        let commit = sc::commit_hash(&bid, who.id().as_str(), &self.sale_id());
        let deposit = sc::cost(price, size, self.dec()).unwrap() + extra;
        let idx = self.recs.len();
        who.call(self.sale.id(), "bid")
            .args_json(json!({"ciphertext": self.ct(idx), "commit": hx(&commit)}))
            .deposit(NearToken::from_yoctonear(FEE + deposit))
            .transact().await?.into_result()?;
        self.recs.push(Rec { bidder: who.id().to_string(), commit, deposit, plain: Some(bid) });
        Ok(idx)
    }

    pub fn entries(&self) -> Vec<sc::BidEntry> {
        self.recs.iter().map(|r| sc::BidEntry { bidder: r.bidder.clone(), commit: r.commit, deposit: r.deposit, plaintext: r.plain.clone() }).collect()
    }

    pub fn result(&self) -> sc::ClearingResult {
        sc::clear(&self.sc_params(), &self.entries()).unwrap()
    }

    /// The JSON a correct worker would return.
    pub fn tee_output(&self) -> Value {
        let r = self.result();
        let pl: Vec<Value> = self.recs.iter().map(|x| match &x.plain {
            Some(b) => json!({"price": b.price.to_string(), "size": b.size.to_string(), "salt": hx(&b.salt)}),
            None => Value::Null,
        }).collect();
        json!({
            "sale_id": self.sale_id(), "input_hash": hx(&r.input_hash), "code_hash": CODE_HASH,
            "p_star": r.p_star.to_string(), "sold": r.sold.to_string(), "burned": r.burned.to_string(),
            "raise": r.raise.to_string(), "alloc_root": hx(&r.alloc_root), "leaf_count": r.leaves.len(),
            "plaintexts": pl
        })
    }

    pub async fn set_response(&self, v: &Value) -> anyhow::Result<()> {
        self.mock.call("set_response").args_json(json!({"response": v.to_string()})).transact().await?.into_result()?;
        Ok(())
    }

    pub async fn ff_past_bid_end(&self) -> anyhow::Result<()> {
        let end: u64 = self.params["bid_end_ms"].as_str().unwrap().parse().unwrap();
        while chain_ms(&self.w).await <= end + 1000 {
            self.w.fast_forward(200).await?;
        }
        Ok(())
    }
    pub async fn ff_secs(&self, secs: u64) -> anyhow::Result<()> {
        let target = chain_ms(&self.w).await + secs * 1000;
        while chain_ms(&self.w).await <= target {
            self.w.fast_forward(200).await?;
        }
        Ok(())
    }

    /// Finalize attaching the contract's own `get_finalize_deposit().recommended` (as scripts/web do).
    pub async fn finalize(&self, who: &Account) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
        let d = self.finalize_deposit(None).await?;
        let amt: u128 = d["recommended"].as_str().unwrap().parse()?;
        self.finalize_with(who, amt).await
    }
    pub async fn finalize_with(&self, who: &Account, yocto: u128) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
        Ok(who.call(self.sale.id(), "finalize").deposit(NearToken::from_yoctonear(yocto)).gas(Gas::from_tgas(300)).transact().await?)
    }
    pub async fn finalize_deposit(&self, bid_count: Option<u32>) -> anyhow::Result<Value> {
        Ok(self.sale.view("get_finalize_deposit").args_json(serde_json::json!({ "bid_count": bid_count })).await?.json::<Value>()?)
    }

    pub async fn sale_view(&self) -> Value {
        self.sale.view("get_sale").await.unwrap().json::<Value>().unwrap()
    }
    pub async fn status(&self) -> String {
        self.sale_view().await["status"].as_str().unwrap().to_string()
    }

    pub async fn claim(&self, who: &Account, r: &sc::ClearingResult, bidder: &str) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
        let hs: Vec<[u8; 32]> = r.leaves.iter().map(sc::leaf_hash).collect();
        let i = r.leaves.iter().position(|l| l.bidder == bidder).unwrap();
        let proof: Vec<String> = sc::merkle_proof(&hs, i).iter().map(|h| hx(h)).collect();
        Ok(who.call(self.sale.id(), "claim")
            .args_json(json!({"bidder": bidder, "index": i, "tokens": r.leaves[i].tokens.to_string(), "refund": r.leaves[i].refund.to_string(), "proof": proof}))
            .gas(Gas::from_tgas(100)).transact().await?)
    }
}

pub fn logs_contain(r: &near_workspaces::result::ExecutionFinalResult, s: &str) -> bool {
    r.logs().iter().any(|l| l.contains(s))
}
pub async fn balance(a: &Account) -> u128 {
    a.view_account().await.unwrap().balance.as_yoctonear()
}

impl Env {
    pub fn clone_entries_without(&self, drop_idx: usize) -> Vec<sc::BidEntry> {
        let mut e = self.entries();
        e[drop_idx].plaintext = None;
        e
    }
    /// Output built from arbitrary entries (e.g. a lying TEE); input_hash is over the real stored slots.
    pub fn tee_output_for(&self, entries: &[sc::BidEntry], r: &sc::ClearingResult) -> Value {
        let pl: Vec<Value> = entries.iter().map(|x| match &x.plaintext {
            Some(b) => json!({"price": b.price.to_string(), "size": b.size.to_string(), "salt": hx(&b.salt)}),
            None => Value::Null,
        }).collect();
        json!({
            "sale_id": self.sale_id(), "input_hash": hx(&r.input_hash), "code_hash": CODE_HASH,
            "p_star": r.p_star.to_string(), "sold": r.sold.to_string(), "burned": r.burned.to_string(),
            "raise": r.raise.to_string(), "alloc_root": hx(&r.alloc_root), "leaf_count": r.leaves.len(),
            "plaintexts": pl
        })
    }
}
