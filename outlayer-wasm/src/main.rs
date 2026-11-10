use std::io::{Read, Write};

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let env = sl_worker::Env::from_process();
    let out = match sl_worker::run(&raw, &env) {
        Ok(v) => v,
        Err(e) => serde_json::json!({ "error": e }),
    };
    print!("{}", out);
    std::io::stdout().flush().unwrap();
}
