// Generates fixtures.json: ciphertexts made by JS eciesjs 0.4.x for a fixed TEST master.
// Independent key derivation (node:crypto HKDF + eciesjs PrivateKey) so the Rust worker's
// key derivation is cross-checked too. Run: node gen.mjs
import { encrypt, PrivateKey } from 'eciesjs';
import { hkdfSync } from 'node:crypto';
import fs from 'node:fs';
const ver = JSON.parse(fs.readFileSync('node_modules/eciesjs/package.json', 'utf8')).version;

const MASTER = Buffer.alloc(32, 0x5a);              // TEST ONLY
const SALE = 'sale-demo.sealedlaunch.testnet';
const OTHER = 'sale-other.sealedlaunch.testnet';
const pkOf = (sale) => {
  const sk = Buffer.from(hkdfSync('sha256', MASTER, Buffer.alloc(0), `sale:${sale}`, 32));
  return new PrivateKey(sk).publicKey.compressed;
};
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(n) >> 64n, 0); b.writeBigUInt64BE(BigInt(n) & 0xffffffffffffffffn, 8); return b; };
const bidBytes = (price, size, saltByte) => Buffer.concat([u128(price), u128(size), Buffer.alloc(32, saltByte)]);
const enc = (pk, buf) => Buffer.from(encrypt(pk, buf)).toString('hex');

const vec = JSON.parse(fs.readFileSync('../../clearing/vectors.json', 'utf8'));
const c0 = vec.clearing_vectors.find((c) => c.name === 'oversubscribed');
const pk = pkOf(SALE);
const entries = c0.entries.map((e) => ({
  bidder: e.bidder, commit: e.commit, deposit: e.deposit,
  ciphertext: enc(pk, bidBytes(BigInt(e.plaintext.price), BigInt(e.plaintext.size), parseInt(e.plaintext.salt.slice(0, 2), 16))),
}));
// a ciphertext for a different sale's key (must not decrypt under SALE), and a 63-byte payload
const wrongSale = enc(pkOf(OTHER), bidBytes(10, 40, 1));
const shortPayload = enc(pk, bidBytes(10, 40, 1).subarray(0, 63));

fs.writeFileSync('fixtures.json', JSON.stringify({
  eciesjs_version: ver, master_hex: MASTER.toString('hex'), sale: SALE,
  pubkey_hex: Buffer.from(pk).toString('hex'), vector: 'oversubscribed',
  entries, wrong_sale_ciphertext: wrongSale, short_payload_ciphertext: shortPayload,
}, null, 1));
console.log('eciesjs', ver, 'entries', entries.length);
