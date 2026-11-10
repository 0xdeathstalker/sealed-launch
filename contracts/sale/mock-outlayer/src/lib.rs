//! Test-only mock: plays outlayer.testnet (request_execution returns a configured response), Ref Finance,
//! wNEAR, and a NEP-141 payment token that can fire ft_on_transfer at a sale (for bulk bid setup).
use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct Mock {
    response: String,
    pub calls: Vec<String>,
    pub last_args_len: u64,
    pub last_deposit: U128,
    pub last_prepaid_tgas: u64,
}

#[near(serializers=[json])]
pub struct FakeBid {
    pub sender: AccountId,
    pub amount: U128,
    pub msg: String,
}

#[near]
impl Mock {
    pub fn set_response(&mut self, response: String) {
        self.response = response;
    }
    pub fn get_calls(&self) -> Vec<String> {
        self.calls.clone()
    }
    /// outlayer.request_execution: ignores args, returns the configured JSON (default null).
    #[payable]
    pub fn request_execution(&mut self) -> Value {
        self.last_args_len = env::input().map(|i| i.len() as u64).unwrap_or(0);
        self.last_deposit = U128(env::attached_deposit().as_yoctonear());
        self.last_prepaid_tgas = env::prepaid_gas().as_tgas();
        self.calls.push("request_execution".into());
        if self.response.is_empty() {
            Value::Null
        } else {
            near_sdk::serde_json::from_str(&self.response).unwrap_or(Value::Null)
        }
    }
    /// Acts as the payment token: calls sale.ft_on_transfer for each fake bid (predecessor = this account).
    pub fn fake_bids(&mut self, sale: AccountId, bids: Vec<FakeBid>) {
        for b in bids {
            Promise::new(sale.clone()).function_call(
                "ft_on_transfer".to_string(),
                near_sdk::serde_json::json!({"sender_id": b.sender, "amount": b.amount, "msg": b.msg}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            );
        }
    }
    // ---- Ref / wNEAR / FT surface (records calls, accepts everything)
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) {
        self.calls.push(format!("storage_deposit {:?} {:?}", account_id, registration_only));
    }
    #[payable]
    pub fn register_tokens(&mut self, token_ids: Vec<AccountId>) {
        self.calls.push(format!("register_tokens {:?}", token_ids));
    }
    #[payable]
    pub fn near_deposit(&mut self) {
        self.calls.push(format!("near_deposit {}", env::attached_deposit().as_yoctonear()));
    }
    #[payable]
    pub fn add_simple_pool(&mut self, tokens: Vec<AccountId>, fee: u32) -> u64 {
        self.calls.push(format!("add_simple_pool {:?} {}", tokens, fee));
        7
    }
    #[payable]
    pub fn add_liquidity(&mut self, pool_id: u64, amounts: Vec<U128>) {
        self.calls.push(format!("add_liquidity {} {:?}", pool_id, amounts));
    }
    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, msg: String) -> U128 {
        self.calls.push(format!("ft_transfer_call {} {} {}", receiver_id, amount.0, msg));
        amount
    }
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128) {
        self.calls.push(format!("ft_transfer {} {}", receiver_id, amount.0));
    }
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        self.calls.push(format!("ft_on_transfer {} {} {}", sender_id, amount.0, msg));
        U128(0)
    }
}
