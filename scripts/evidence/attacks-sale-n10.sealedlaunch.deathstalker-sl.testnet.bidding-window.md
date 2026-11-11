| attack | variant | expected | actual | verdict | tx |
|---|---|---|---|---|---|
| forged_on_clear | attacker calls on_clear({nonce}) directly | Rejected (private callback, only the contract itself) | {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: Method on_clear is private"}}}} | PASS: rejected as expected | [5jSaoQQ1](https://testnet.nearblocks.io/txns/5jSaoQQ1gYqcxeK7TKKWeqK3VEA93p7ZYsAqExEh1qcy) |
| tampered_claim_proof | claim with tokens+1 (inflated allocation) and the real proof | Rejected (invalid merkle proof) | n/a | SKIPPED |  |
| tampered_claim_proof | claim with refund+1 yocto and the real proof | Rejected (invalid merkle proof) | n/a | SKIPPED |  |
| tampered_claim_proof | claim with an empty proof | Rejected (invalid merkle proof) | n/a | SKIPPED |  |
| tampered_claim_proof | steal: claim leaf 0's tokens/refund/proof for a non-bidder account name (name swapped) | Rejected (invalid merkle proof) | n/a | SKIPPED |  |
| double_claim | second claim with the correct proof for an already claimed bidder | Rejected (already claimed) | n/a | SKIPPED |  |
| bid_after_deadline | bid() after bid_end | Rejected (bidding closed) | n/a | SKIPPED |  |
| finalize_before_deadline | finalize() while bidding is open | Rejected (bid window still open) | {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: bidding still open"}}}} | PASS: rejected as expected | [J5r1aniC](https://testnet.nearblocks.io/txns/J5r1aniCxKHB189byMi66iRjdtAJUQ3XHuHNysogsSgf) |
| refund_not_refund_mode | refund(0) on a non-refund sale | Rejected (not in refund mode) | {"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: not in refund mode"}}}} | PASS: rejected as expected | [Dx7Qz3iq](https://testnet.nearblocks.io/txns/Dx7Qz3iqV3fTWXHByjYaVcxhDvZpqSi5Y8r9fuY7XHTh) |
