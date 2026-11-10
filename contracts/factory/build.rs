// Embeds the sale wasm. Lookup order:
//   1. $SALE_WASM_PATH
//   2. ../sale/res/*.wasm   3. ../sale/target/near/*.wasm   (cargo-near outputs)
//   4. 8-byte empty-module placeholder (create_sale refuses to run with it)
use std::{env, fs, path::PathBuf};

fn first_wasm(dir: &str) -> Option<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |x| x == "wasm")).collect();
    v.sort();
    v.into_iter().next()
}

fn main() {
    println!("cargo:rerun-if-env-changed=SALE_WASM_PATH");
    println!("cargo:rerun-if-changed=../sale/res");
    println!("cargo:rerun-if-changed=../sale/target/near");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("sale.wasm");
    let src = env::var("SALE_WASM_PATH").ok().map(PathBuf::from)
        .or_else(|| first_wasm("../sale/res"))
        .or_else(|| first_wasm("../sale/target/near"));
    match src {
        Some(p) if p.exists() => {
            println!("cargo:rerun-if-changed={}", p.display());
            fs::copy(&p, &out).expect("copy sale wasm");
            fs::write(out.with_file_name("placeholder.rs"), "pub const IS_PLACEHOLDER: bool = false;").unwrap();
            println!("cargo:warning=embedding sale wasm from {}", p.display());
        }
        _ => {
            fs::write(&out, b"\0asm\x01\0\0\0").unwrap();
            fs::write(out.with_file_name("placeholder.rs"), "pub const IS_PLACEHOLDER: bool = true;").unwrap();
            println!("cargo:warning=NO sale wasm found: embedding PLACEHOLDER (create_sale will refuse)");
        }
    }
}
