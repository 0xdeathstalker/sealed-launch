//! SealedLaunch TEE worker. SPEC.md section 5 (v1.1). stdin JSON -> stdout JSON.
//!
//! Actions:
//!   derive_pubkey: {action, sale} -> {pubkey}
//!   clear: {action, params:{sale_id,supply,reserve,token_decimals,min_size,bid_end_ms,code_hash},
//!           entries:[{bidder,commit,deposit,ciphertext(hex) | ciphertext_b64}]} -> SPEC section 5 output
//!
//! Decryption-oracle guard (mandatory): see `guard_*`.
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use sealed_clearing::{self as sc, Bid, BidEntry, Params};

/// Environment as provided by OutLayer. Injectable for tests.
#[derive(Clone, Debug, Default)]
pub struct Env {
    /// `PROTECTED_SL_MASTER` (hex, 32 bytes)
    pub master_hex: String,
    /// `NEAR_PREDECESSOR_ID`
    pub predecessor: String,
    /// `NEAR_BLOCK_TIMESTAMP` in NANOSECONDS
    pub block_ts_ns: String,
}

impl Env {
    pub fn from_process() -> Env {
        let g = |k: &str| std::env::var(k).unwrap_or_default();
        Env {
            master_hex: g("PROTECTED_SL_MASTER"),
            predecessor: g("NEAR_PREDECESSOR_ID"),
            block_ts_ns: g("NEAR_BLOCK_TIMESTAMP"),
        }
    }
}

#[derive(Deserialize)]
struct WireParams {
    sale_id: String,
    supply: String,
    reserve: String,
    token_decimals: u8,
    min_size: String,
    /// unix milliseconds (same unit as create_sale's bid_end_ms)
    bid_end_ms: serde_json::Number,
    code_hash: String,
}

#[derive(Deserialize)]
struct WireEntry {
    bidder: String,
    commit: String,
    deposit: String,
    #[serde(default)]
    ciphertext: Option<String>,
    #[serde(default)]
    ciphertext_b64: Option<String>,
}

#[derive(Deserialize)]
struct Input {
    action: String,
    #[serde(default)]
    sale: Option<String>,
    #[serde(default)]
    params: Option<WireParams>,
    #[serde(default)]
    entries: Vec<WireEntry>,
}

fn keypair(master: &[u8], sale: &str) -> Result<([u8; 32], Vec<u8>), String> {
    let mut seed = [0u8; 32];
    Hkdf::<Sha256>::new(None, master)
        .expand(format!("sale:{}", sale).as_bytes(), &mut seed)
        .map_err(|e| e.to_string())?;
    let sk = libsecp256k1::SecretKey::parse_slice(&seed).map_err(|e| format!("{:?}", e))?;
    let pk = libsecp256k1::PublicKey::from_secret_key(&sk);
    Ok((seed, pk.serialize_compressed().to_vec()))
}

fn u128s(s: &str, what: &str) -> Result<u128, String> {
    s.parse::<u128>().map_err(|_| format!("bad {}", what))
}

fn h32(s: &str, what: &str) -> Result<[u8; 32], String> {
    hex::decode(s)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .ok_or_else(|| format!("bad {}", what))
}

// ------------------------------------------------------------ guard

/// derive_pubkey: predecessor must be the sale itself or its factory
/// (the factory is the parent account: sale = "<label>.<factory>").
pub fn guard_derive(env: &Env, sale: &str) -> Result<(), String> {
    let p = env.predecessor.as_str();
    if p.is_empty() || sale.is_empty() {
        return Err("refused: missing predecessor or sale".into());
    }
    let is_factory = sale.len() > p.len() + 1 && sale.ends_with(p) && sale.as_bytes()[sale.len() - p.len() - 1] == b'.';
    if p == sale || is_factory {
        Ok(())
    } else {
        Err(format!("refused: predecessor {} is neither sale {} nor its factory", p, sale))
    }
}

/// clear: predecessor must be exactly the sale, and the chain's block time
/// (ns) must be >= bid_end (ms, converted). bid_end comes from the input, but
/// the input can only have been produced by the sale contract (predecessor
/// check), which stores it from create_sale.
pub fn guard_clear(env: &Env, sale: &str, bid_end_ms: u64) -> Result<(), String> {
    if env.predecessor.is_empty() || env.predecessor != sale {
        return Err(format!("refused: predecessor '{}' is not sale '{}'", env.predecessor, sale));
    }
    if bid_end_ms == 0 {
        return Err("refused: bid_end_ms missing".into());
    }
    let now_ns: u128 = env
        .block_ts_ns
        .parse()
        .map_err(|_| "refused: NEAR_BLOCK_TIMESTAMP missing or invalid".to_string())?;
    if now_ns == 0 {
        return Err("refused: NEAR_BLOCK_TIMESTAMP is zero".into());
    }
    let end_ns = bid_end_ms as u128 * 1_000_000;
    if now_ns < end_ns {
        return Err(format!("refused: bidding open (block time {} ns < bid_end {} ns)", now_ns, end_ns));
    }
    Ok(())
}

// ------------------------------------------------------------ run

pub fn run(raw: &str, env: &Env) -> Result<Value, String> {
    let inp: Input = serde_json::from_str(raw).map_err(|e| format!("bad input: {}", e))?;
    match inp.action.as_str() {
        "derive_pubkey" => {
            let sale = inp.sale.ok_or("missing sale")?;
            guard_derive(env, &sale)?;
            let (_, pk) = keypair(&master(env)?, &sale)?;
            Ok(json!({ "pubkey": hex::encode(pk) }))
        }
        "clear" => clear_action(inp, env),
        _ => Err("bad action".into()),
    }
}

fn master(env: &Env) -> Result<Vec<u8>, String> {
    if env.master_hex.is_empty() {
        return Err("PROTECTED_SL_MASTER missing".into());
    }
    let m = hex::decode(&env.master_hex).map_err(|_| "PROTECTED_SL_MASTER not hex".to_string())?;
    if m.len() < 32 {
        return Err("PROTECTED_SL_MASTER too short".into());
    }
    Ok(m)
}

fn clear_action(inp: Input, env: &Env) -> Result<Value, String> {
    let wp = inp.params.ok_or("missing params")?;
    let bid_end_ms = wp.bid_end_ms.as_u64().ok_or("bad bid_end_ms")?;
    // Guard BEFORE touching the master secret or any ciphertext.
    guard_clear(env, &wp.sale_id, bid_end_ms)?;
    if let Some(s) = &inp.sale {
        if s != &wp.sale_id {
            return Err("refused: sale != params.sale_id".into());
        }
    }
    h32(&wp.code_hash, "code_hash")?;
    let params = Params {
        sale_id: wp.sale_id.clone(),
        supply: u128s(&wp.supply, "supply")?,
        reserve: u128s(&wp.reserve, "reserve")?,
        token_decimals: wp.token_decimals,
        min_size: u128s(&wp.min_size, "min_size")?,
    };
    let (sk, _) = keypair(&master(env)?, &wp.sale_id)?;
    let mut entries = Vec::with_capacity(inp.entries.len());
    for e in &inp.entries {
        let ct: Option<Vec<u8>> = match (&e.ciphertext, &e.ciphertext_b64) {
            (Some(h), _) => hex::decode(h).ok(),
            (None, Some(b)) => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(b).ok()
            }
            _ => None,
        };
        let plaintext: Option<Bid> = ct
            .and_then(|c| ecies::decrypt(&sk, &c).ok())
            .and_then(|p| sc::decode_bid(&p));
        entries.push(BidEntry {
            bidder: e.bidder.clone(),
            commit: h32(&e.commit, "commit")?,
            deposit: u128s(&e.deposit, "deposit")?,
            plaintext,
        });
    }
    let res = sc::clear(&params, &entries).map_err(|e| format!("clearing error: {:?}", e))?;
    let plaintexts: Vec<Value> = entries
        .iter()
        .map(|e| match &e.plaintext {
            Some(b) => json!({ "price": b.price.to_string(), "size": b.size.to_string(), "salt": hex::encode(b.salt) }),
            None => Value::Null,
        })
        .collect();
    Ok(json!({
        "sale_id": wp.sale_id,
        // NOTE: a WASM cannot know its own sha256 and OutLayer exposes no env var for it.
        // This echoes the code_hash the sale passed in; the binding to the real build
        // is the secret's --build lock plus the attestation's wasm_hash (see README).
        "code_hash": wp.code_hash,
        "input_hash": hex::encode(res.input_hash),
        "p_star": res.p_star.to_string(),
        "sold": res.sold.to_string(),
        "burned": res.burned.to_string(),
        "raise": res.raise.to_string(),
        "alloc_root": hex::encode(res.alloc_root),
        "leaf_count": res.leaves.len(),
        "plaintexts": plaintexts,
    }))
}
