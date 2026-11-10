// TEST MOCK of outlayer.testnet request_execution for derive_pubkey. Sale names containing
// "nokey" get `null` (failed run, as the real OutLayer returns); "garbage" gets junk JSON.
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct MockOutlayer { last: Option<String>, calls: u32 }

#[near]
impl MockOutlayer {
    #[payable]
    pub fn request_execution(&mut self, source: Value, input_data: String, secrets_ref: Value) -> Value {
        let inp: Value = serde_json::from_str(&input_data).unwrap();
        require_eq(&inp["action"], "derive_pubkey");
        let sale = inp["sale"].as_str().unwrap().to_string();
        self.calls += 1;
        self.last = Some(json!({"sale": sale, "source": source, "secrets_ref": secrets_ref,
            "deposit": env::attached_deposit().as_yoctonear().to_string(), "predecessor": env::predecessor_account_id()}).to_string());
        if sale.contains("nokey") { return Value::Null; }
        if sale.contains("garbage") { return json!({"pubkey": "zz"}); }
        let h = env::sha256(sale.as_bytes());
        let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
        json!({"pubkey": format!("02{hex}")})
    }
    pub fn get_last(&self) -> Option<String> { self.last.clone() }
    pub fn get_calls(&self) -> u32 { self.calls }
}
fn require_eq(v: &Value, s: &str) { if v.as_str() != Some(s) { env::panic_str("bad action"); } }
