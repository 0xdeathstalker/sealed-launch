// TEST MOCK of the sale interface the factory relies on: init(p, creator) + set_pubkey(pk).
use near_sdk::serde_json::Value;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSale {
    factory: AccountId,
    creator: AccountId,
    symbol: String,
    pk: Option<String>,
}

#[near]
impl MockSale {
    #[init]
    pub fn new(p: Value) -> Self {
        let creator: AccountId = p["creator"].as_str().expect("creator").parse().unwrap();
        require!(p["factory"].as_str() == Some(env::predecessor_account_id().as_str()), "factory wiring");
        let symbol = p["symbol"].as_str().unwrap_or("").to_string();
        require!(symbol != "BAD", "mock init failure");
        Self { factory: env::predecessor_account_id(), creator, symbol, pk: None }
    }
    pub fn set_pubkey(&mut self, pubkey: String) {
        let pk = pubkey;
        require!(env::predecessor_account_id() == self.factory, "factory only");
        require!(self.pk.is_none(), "pk already set");
        require!(self.symbol != "NOSET", "mock set_pubkey failure");
        self.pk = Some(pk);
    }
    pub fn get_pubkey(&self) -> Option<String> { self.pk.clone() }
    pub fn get_creator(&self) -> AccountId { self.creator.clone() }
    pub fn get_factory(&self) -> AccountId { self.factory.clone() }
}
