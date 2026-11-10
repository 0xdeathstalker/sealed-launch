import { encrypt, decrypt } from "eciesjs";
import { Bid, bidBytes, parseBidBytes } from "./clearing";
import { hex, unhex } from "./bytes";

/** ECIES (eciesjs defaults, secp256k1) of the 64-byte bid to pk_sale (hex, compressed or uncompressed). Returns lowercase hex. */
export function encryptBid(pkSaleHex: string, bid: Bid): string {
  return hex(new Uint8Array(encrypt(unhex(pkSaleHex), bidBytes(bid))));
}
/** Returns null if undecryptable or not exactly 64 bytes. */
export function decryptBid(skHex: string, ciphertextHex: string): Bid | null {
  try { return parseBidBytes(new Uint8Array(decrypt(unhex(skHex), unhex(ciphertextHex)))); } catch { return null; }
}
