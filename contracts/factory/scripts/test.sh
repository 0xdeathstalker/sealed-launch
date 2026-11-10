#!/usr/bin/env bash
# Builds mock sale + mock outlayer, builds the factory embedding the MOCK sale wasm, runs sandbox tests.
set -euo pipefail
cd "$(dirname "$0")/.."
for m in sale outlayer; do
  (cd tests/mocks/$m && cargo near build non-reproducible-wasm --no-abi 2>&1 | tail -3)
done
MOCK_SALE=$(ls "$PWD"/tests/mocks/sale/target/near/mock_sale.wasm)
SALE_WASM_PATH="$MOCK_SALE" cargo near build non-reproducible-wasm --no-abi 2>&1 | tail -3
cargo test --release -- --nocapture "$@"
