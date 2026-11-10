#!/usr/bin/env bash
# Usage: scripts/verify_keyless.sh sale-<name>.<factory> [network]
# Prints the access key list via RPC; exits non-zero unless it is empty.
set -euo pipefail
ACC=${1:?sale account}; NET=${2:-testnet}
case $NET in testnet) RPC=https://rpc.testnet.near.org;; mainnet) RPC=https://rpc.mainnet.near.org;; *) echo bad net; exit 2;; esac
OUT=$(curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$ACC\"}}")
N=$(echo "$OUT" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(len(r["result"]["keys"]) if "result" in r else "ERR")')
echo "$ACC access keys: $N"
[ "$N" = 0 ]
