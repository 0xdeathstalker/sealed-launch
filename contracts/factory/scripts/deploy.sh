#!/usr/bin/env bash
# Deploy the factory to testnet. NOT RUN by the agent. Review, then run manually.
# Needs: near-cli-rs (`near`), a built wasm with the REAL sale embedded (scripts/build.sh), and a funded signer.
# The parent account (default sealedlaunch.deathstalker-sl.testnet) is created as a sub-account of the signer.
set -euo pipefail
cd "$(dirname "$0")/.."
SIGNER=${SIGNER:-deathstalker-sl.testnet}
FACTORY=${FACTORY:-sealedlaunch.deathstalker-sl.testnet}
OUTLAYER=${OUTLAYER:-outlayer.testnet}
NETWORK=${NETWORK:-testnet}
FUND=${FUND:-15 NEAR}   # factory balance: covers its own storage; sale funding comes from creators
WASM=target/near/sl_factory.wasm
[ "$NETWORK" = testnet ] || { echo "refusing non-testnet network"; exit 1; }
[ -f "$WASM" ] || { echo "build first: scripts/build.sh"; exit 1; }

near account create-account fund-myself "$FACTORY" "$FUND" autogenerate-new-keypair save-to-keychain \
  sign-as "$SIGNER" network-config "$NETWORK" sign-with-keychain send

near contract deploy "$FACTORY" use-file "$WASM" with-init-call new \
  json-args "{\"owner\":\"$SIGNER\",\"outlayer\":\"$OUTLAYER\",\"outlayer_deposit\":\"50000000000000000000000\",\"storage_buffer\":\"2000000000000000000000000\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-keychain send

near contract call-function as-read-only "$FACTORY" is_placeholder_build json-args '{}' network-config "$NETWORK" now
near contract call-function as-read-only "$FACTORY" get_sale_code_hash json-args '{}' network-config "$NETWORK" now
