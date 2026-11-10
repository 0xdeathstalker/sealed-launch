#!/usr/bin/env bash
# Production build. Usage: SALE_WASM_PATH=/abs/path/sale.wasm scripts/build.sh
# Without SALE_WASM_PATH it falls back to ../sale/res/*.wasm or ../sale/target/near/*.wasm, else a placeholder
# (a placeholder factory refuses create_sale).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo near build non-reproducible-wasm --no-abi
echo "factory wasm: $PWD/target/near/sl_factory.wasm"
