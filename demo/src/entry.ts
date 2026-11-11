// Browser entry: exposes the REAL clearing-js (SPEC v1.1) to the demo page.
import { PrivateKey } from "eciesjs";
import {
  clear, commitHash, cost, bidBytes, encryptBid, decryptBid, leafHash, merkleRoot, merkleProof, verifyProof, hex, unhex,
} from "../../clearing-js/src/index";

function newTeeKey() {
  const sk = new PrivateKey();
  return { skHex: sk.toHex(), pkHex: sk.publicKey.toHex(true) };
}
(window as any).SL = { clear, commitHash, cost, bidBytes, encryptBid, decryptBid, leafHash, merkleRoot, merkleProof, verifyProof, hex, unhex, newTeeKey };
