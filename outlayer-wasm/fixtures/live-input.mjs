// node live-input.mjs <sale> <pubkey_hex> <bid_end_ms> <outfile>  -> clear input_data for a live run
import { encrypt } from 'eciesjs'; import { createHash } from 'node:crypto'; import fs from 'node:fs';
const [sale, pk, bidEnd, out] = process.argv.slice(2);
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(n) >> 64n, 0); b.writeBigUInt64BE(BigInt(n) & 0xffffffffffffffffn, 8); return b; };
const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
const entries = [['a.testnet', 10, 40, 1], ['b.testnet', 8, 30, 2], ['c.testnet', 5, 50, 3]].map(([bidder, price, size, s]) => {
  const bb = Buffer.concat([u128(price), u128(size), Buffer.alloc(32, s)]);
  const commit = createHash('sha256').update(Buffer.concat([bb, str(bidder), str(sale)])).digest('hex');
  return { bidder, commit, deposit: String(price * size), ciphertext: Buffer.from(encrypt(pk, bb)).toString('hex') };
});
fs.writeFileSync(out, JSON.stringify({ action: 'clear', params: { sale_id: sale, supply: '100', reserve: '1', token_decimals: 0, min_size: '0', bid_end_ms: Number(bidEnd), code_hash: '607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6' }, entries }));
