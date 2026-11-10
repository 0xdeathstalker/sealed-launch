//! Auto-LP on Ref Finance (`ref-finance-101.testnet`). ISOLATED: everything venue-specific is here.
//! Status: implemented from the documented Ref API (RESEARCH.md), exercised only against a mock in the
//! sandbox tests. NOT run against the real Ref contract (deposit amounts are guesses, see NOTES.md).
//! To swap venues, replace `start_lp`, `lp_add_liquidity`, `lp_done`.
use crate::*;
use near_contract_standards::fungible_token::core::ext_ft_core;

#[ext_contract(ext_ref)]
pub trait ExtRef {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn register_tokens(&mut self, token_ids: Vec<AccountId>);
    fn add_simple_pool(&mut self, tokens: Vec<AccountId>, fee: u32) -> u64;
    fn add_liquidity(&mut self, pool_id: u64, amounts: Vec<U128>, min_amounts: Option<Vec<U128>>);
}

#[ext_contract(ext_wnear)]
pub trait ExtWnear {
    fn near_deposit(&mut self);
}

impl Sale {
    /// Chain: [wrap NEAR] -> register on quote token -> Ref storage + register_tokens -> push both tokens
    /// to Ref -> add_simple_pool -> add_liquidity -> lp_done. LP shares stay in Ref under this keyless account.
    pub(crate) fn start_lp(&mut self, lp_funds: u128, lp_tokens: u128) -> Promise {
        let rf = self.cfg.ref_exchange.clone().unwrap();
        let me = env::current_account_id();
        let quote = self.cfg.payment_token.clone().unwrap_or_else(|| self.cfg.wnear.clone().unwrap());
        // our own token: Ref must be registered on it
        if self.token.accounts.get(&rf).is_none() {
            self.token.internal_register_account(&rf);
        }
        let reg = NearToken::from_millinear(10); // excess refunded by storage_deposit(registration_only)
        let g = |t| Gas::from_tgas(t);
        let mut p = ext_ref::ext(quote.clone()).with_attached_deposit(reg).with_static_gas(g(10)).storage_deposit(Some(rf.clone()), Some(true));
        if self.cfg.payment_token.is_none() {
            // wrap NEAR; wrap.testnet registration of this account is part of near_deposit (UNVERIFIED) -> register first
            p = p
                .then(ext_ref::ext(quote.clone()).with_attached_deposit(reg).with_static_gas(g(10)).storage_deposit(Some(me.clone()), Some(true)))
                .then(ext_wnear::ext(quote.clone()).with_attached_deposit(NearToken::from_yoctonear(lp_funds)).with_static_gas(g(10)).near_deposit());
        }
        let p = p
            .then(ext_ref::ext(rf.clone()).with_attached_deposit(NearToken::from_millinear(100)).with_static_gas(g(10)).storage_deposit(Some(me.clone()), None))
            .then(ext_ref::ext(rf.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(g(10)).register_tokens(vec![me.clone(), quote.clone()]))
            .then(ext_ft_core::ext(quote.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(g(40)).ft_transfer_call(rf.clone(), U128(lp_funds), None, String::new()))
            .then(ext_ft_core::ext(me.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(g(40)).ft_transfer_call(rf.clone(), U128(lp_tokens), None, String::new()));
        let mut toks = vec![me.clone(), quote];
        toks.sort();
        let sale_first = toks[0] == me;
        p.then(ext_ref::ext(rf).with_attached_deposit(NearToken::from_millinear(10)).with_static_gas(g(20)).add_simple_pool(toks, 30))
            .then(Self::ext(me).with_static_gas(g(40)).lp_add_liquidity(sale_first, U128(lp_tokens), U128(lp_funds)))
    }
}

#[near]
impl Sale {
    #[private]
    pub fn lp_add_liquidity(&mut self, sale_first: bool, lp_tokens: U128, lp_funds: U128) -> Promise {
        let pool_id: u64 = match env::promise_result_checked(0, 64).ok().and_then(|b| near_sdk::serde_json::from_slice(&b).ok()) {
            Some(id) => id,
            None => {
                self.lp_status = LpStatus::Failed;
                log!("EVENT_JSON:{{\"event\":\"lp_failed\",\"at\":\"add_simple_pool\"}}");
                return Promise::new(env::current_account_id()).function_call("lp_done".to_string(), b"{\"ok\":false}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(5));
            }
        };
        let amounts = if sale_first { vec![lp_tokens, lp_funds] } else { vec![lp_funds, lp_tokens] };
        ext_ref::ext(self.cfg.ref_exchange.clone().unwrap())
            .with_attached_deposit(NearToken::from_millinear(20))
            .with_static_gas(Gas::from_tgas(30))
            .add_liquidity(pool_id, amounts, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).lp_done(true))
    }

    #[private]
    pub fn lp_done(&mut self, ok: bool) -> bool {
        let good = ok && env::promise_result_checked(0, 64).is_ok();
        self.lp_status = if good { LpStatus::Done } else { LpStatus::Failed };
        log!("EVENT_JSON:{{\"event\":\"lp_done\",\"ok\":{good}}}");
        good
    }
}
