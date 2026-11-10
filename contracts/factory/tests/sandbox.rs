use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const FACTORY_WASM: &str = "target/near/sl_factory.wasm";
const OUTLAYER_WASM: &str = "tests/mocks/outlayer/target/near/mock_outlayer.wasm";

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    factory: Contract,
    outlayer: Contract,
    user: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let outlayer = worker.dev_deploy(&std::fs::read(OUTLAYER_WASM)?).await?;
    let factory = root
        .create_subaccount("sealedlaunch")
        .initial_balance(NearToken::from_near(50))
        .transact().await?.into_result()?;
    let factory = factory.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    factory.call("new").args_json(json!({
        "owner": root.id(), "outlayer": outlayer.id(),
        "outlayer_deposit": NearToken::from_millinear(50), "storage_buffer": NearToken::from_near(1)
    })).transact().await?.into_result()?;
    let user = root.create_subaccount("alice").initial_balance(NearToken::from_near(200)).transact().await?.into_result()?;
    Ok(Env { worker, factory, outlayer, user })
}

fn params(name: &str, symbol: &str, bid_end_ms: u64) -> Value {
    json!({"p": {
        "name": name, "symbol": symbol, "token_name": "Token", "icon": null, "token_decimals": 18,
        "auction_supply": "1000000", "lp_token_reserve": "500000", "creator_supply": "100000",
        "reserve_price": "1000", "min_size": "1", "bid_fee": "1000", "payment_token": null,
        "bid_end_ms": bid_end_ms.to_string(), "challenge_secs": 600, "lp_bps": 5000, "vesting_secs": 86400,
        "outlayer_project": "deathstalker-sl.testnet/sl-spike", "code_hash": "02".repeat(32), "max_bids": 1000
    }})
}

async fn future_ms(w: &Worker<near_workspaces::network::Sandbox>) -> u64 {
    // sandbox block timestamps start near wall-clock; add a day
    let b = w.view_block().await.unwrap();
    b.timestamp() / 1_000_000 + 86_400_000
}

async fn create(e: &Env, name: &str, symbol: &str, deposit: NearToken) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let ms = future_ms(&e.worker).await;
    Ok(e.user.call(e.factory.id(), "create_sale").args_json(params(name, symbol, ms))
        .deposit(deposit).gas(Gas::from_tgas(300)).transact().await?)
}

async fn required(e: &Env) -> anyhow::Result<NearToken> {
    let r: NearToken = e.factory.view("get_required_deposit").await?.json()?;
    Ok(r)
}

async fn key_count(e: &Env, acc: &near_workspaces::AccountId) -> usize {
    e.worker.view_access_keys(acc).await.unwrap().len()
}

#[tokio::test]
async fn happy_path_creates_keyless_ready_sale() -> anyhow::Result<()> {
    let e = setup().await?;
    let dep = required(&e).await?;
    let r = create(&e, "moon", "MOON", dep).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let res: Value = r.json()?;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["status"], "Ready");

    let sale: near_workspaces::AccountId = e.factory.view("get_sale_account").args_json(json!({"name":"moon"})).await?.json()?;
    assert_eq!(sale.as_str(), format!("sale-moon.{}", e.factory.id()));
    // KEYLESS: zero access keys
    assert_eq!(key_count(&e, &sale).await, 0);
    // contract deployed + initialised + pk installed by factory only
    let pk: Option<String> = e.worker.view(&sale, "get_pubkey").await?.json()?;
    assert_eq!(pk.as_deref(), res["pubkey"].as_str());
    let fac: String = e.worker.view(&sale, "get_factory").await?.json()?;
    assert_eq!(fac, e.factory.id().to_string());
    // outlayer saw a derive for the right sale/project/secrets owner, with factory as predecessor
    let last: Option<String> = e.outlayer.view("get_last").await?.json()?;
    let last: Value = serde_json::from_str(&last.unwrap())?;
    assert_eq!(last["sale"], sale.as_str());
    assert_eq!(last["predecessor"], e.factory.id().as_str());
    assert_eq!(last["secrets_ref"]["account_id"], "deathstalker-sl.testnet");
    // listing
    let list: Vec<String> = e.factory.view("list_sales").args_json(json!({"from":0,"limit":10})).await?.json()?;
    assert_eq!(list, vec![sale.to_string()]);
    // duplicate name rejected
    let r2 = create(&e, "moon", "MOON", dep).await?;
    assert!(r2.is_failure());
    // sale cannot be called by non-factory to reset pk
    let bad = e.user.call(&sale, "set_pubkey").args_json(json!({"pubkey": "02".to_string()+&"11".repeat(32)})).transact().await?;
    assert!(bad.is_failure());
    Ok(())
}

#[tokio::test]
async fn init_failure_rolls_back_and_refunds() -> anyhow::Result<()> {
    let e = setup().await?;
    let dep = required(&e).await?;
    let before = e.user.view_account().await?.balance;
    let r = create(&e, "bad", "BAD", dep).await?;
    let res: Value = r.json()?;
    assert_eq!(res["ok"], false, "{res}");
    // no account, name released, nothing listed
    let sale: near_workspaces::AccountId = format!("sale-bad.{}", e.factory.id()).parse()?;
    assert!(e.worker.view_account(&sale).await.is_err());
    let list: Vec<String> = e.factory.view("list_sales").args_json(json!({"from":0,"limit":10})).await?.json()?;
    assert!(list.is_empty());
    let cnt: u32 = e.factory.view("get_sales_count").await?.json()?;
    assert_eq!(cnt, 0);
    // refund: user lost only gas (well under 1 NEAR), not the deposit
    let after = e.user.view_account().await?.balance;
    assert!(before.as_yoctonear() - after.as_yoctonear() < NearToken::from_near(1).as_yoctonear(), "deposit not refunded");
    // name reusable
    let r = create(&e, "bad", "OK", dep).await?;
    assert_eq!(r.json::<Value>()?["ok"], true);
    Ok(())
}

#[tokio::test]
async fn pk_derivation_failure_leaves_keyless_awaiting_then_retry() -> anyhow::Result<()> {
    let e = setup().await?;
    let dep = required(&e).await?;
    for name in ["nokey1", "garbage1"] {
        let r = create(&e, name, "X", dep).await?;
        let res: Value = r.json()?;
        assert_eq!(res["ok"], false, "{res}");
        assert_eq!(res["status"], "AwaitingPk");
        let sale: near_workspaces::AccountId = e.factory.view("get_sale_account").args_json(json!({"name":name})).await?.json()?;
        assert_eq!(key_count(&e, &sale).await, 0, "must be keyless even when pk derivation failed");
        let pk: Option<String> = e.worker.view(&sale, "get_pubkey").await?.json()?;
        assert!(pk.is_none());
    }
    // retry still fails deterministically for these mock names; but retry of a non-awaiting sale is refused
    let r = e.user.call(e.factory.id(), "retry_pk").args_json(json!({"name":"nokey1"}))
        .deposit(NearToken::from_millinear(50)).gas(Gas::from_tgas(250)).transact().await?;
    assert!(r.is_success());
    let s: Value = e.factory.view("get_sale").args_json(json!({"name":"nokey1"})).await?.json()?;
    assert_eq!(s["status"], "AwaitingPk");
    Ok(())
}

#[tokio::test]
async fn set_pubkey_failure_stays_awaiting_and_keyless() -> anyhow::Result<()> {
    let e = setup().await?;
    let dep = required(&e).await?;
    let r = create(&e, "noset", "NOSET", dep).await?;
    let res: Value = r.json()?;
    assert_eq!(res["ok"], false, "{res}");
    assert_eq!(res["status"], "AwaitingPk");
    let sale: near_workspaces::AccountId = e.factory.view("get_sale_account").args_json(json!({"name":"noset"})).await?.json()?;
    assert_eq!(key_count(&e, &sale).await, 0);
    Ok(())
}

#[tokio::test]
async fn validation_and_deposit_checks() -> anyhow::Result<()> {
    let e = setup().await?;
    let dep = required(&e).await?;
    assert!(create(&e, "cheap", "X", NearToken::from_near(1)).await?.is_failure());
    assert!(create(&e, "Bad.Name", "X", dep).await?.is_failure());
    assert!(create(&e, "", "X", dep).await?.is_failure());
    // lp_token_reserve below ceil(auction_supply * lp_bps / 10000) is rejected
    let mut bad = params("lpsmall", "X", future_ms(&e.worker).await);
    bad["p"]["lp_token_reserve"] = serde_json::json!("499999");
    let r = e.user.call(e.factory.id(), "create_sale").args_json(bad).deposit(dep).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure(), "small lp reserve must be rejected");
    // low gas
    let ms = future_ms(&e.worker).await;
    let r = e.user.call(e.factory.id(), "create_sale").args_json(params("lowgas", "X", ms)).deposit(dep).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.is_failure());
    // placeholder flag false in test build
    let ph: bool = e.factory.view("is_placeholder_build").await?.json()?;
    assert!(!ph);
    Ok(())
}
