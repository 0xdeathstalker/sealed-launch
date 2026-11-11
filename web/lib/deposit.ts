// NEAR to attach to `finalize` (OutLayer execution deposit). Mirrors contracts/sale
// `outlayer_required_deposit` / `get_finalize_deposit` (and scripts/src/lib/sale.ts):
// base 0.001 + max_instructions/1e6 * 1e-10 + 60 s * 1000 * 1e-7 NEAR
// + 1e-5 NEAR per input_data byte beyond 32 KiB (refundable hold). OutLayer refunds everything above
// its actual charge (~0.001 NEAR) to the finalize caller.
import type { BidSlot } from "./types";

const OL_BASE_FEE = 10n ** 21n;
const OL_PER_MINSTR = 10n ** 14n;
const OL_PER_MS = 10n ** 17n;
const OL_FREE_BYTES = 32 * 1024;
const OL_PER_BYTE = 10n ** 19n;
const MILLI = 10n ** 21n;

export interface FinalizeDeposit {
  /** What the sale enforces. */
  required: bigint;
  /** required + 25% (headroom capped at 1 NEAR), rounded up to 0.001 NEAR: what the UI attaches. */
  recommended: bigint;
  inputLen: number;
  source: "contract" | "estimate";
}

export const maxInstructions = (n: number) => 3_000_000_000n + 2_000_000_000n * BigInt(Math.ceil(n / 100));

export function outlayerRequiredDeposit(inputLen: number, n: number): bigint {
  if (n === 0) return 0n;
  const compute = OL_BASE_FEE + (maxInstructions(n) / 1_000_000n) * OL_PER_MINSTR + 60_000n * OL_PER_MS;
  return compute + BigInt(Math.max(0, inputLen - OL_FREE_BYTES)) * OL_PER_BYTE;
}

export function recommendedDeposit(required: bigint): bigint {
  if (required === 0n) return 0n;
  let h = required / 4n;
  if (h > 10n ** 24n) h = 10n ** 24n;
  const r = required + h;
  return ((r + MILLI - 1n) / MILLI) * MILLI;
}

/** `input_data` byte length estimated from the stored slots (for sale wasm without the view). */
export function estimateInputLen(slots: BidSlot[]): number {
  let len = 400;
  for (const s of slots) {
    const ct = s.ciphertext.startsWith("0x") ? s.ciphertext.length - 2 : s.ciphertext.length;
    len += `{"bidder":"","ciphertext":"","commit":"","deposit":""},`.length + s.bidder.length + ct + 64 + s.deposit.length;
  }
  return len;
}

export function estimateFinalizeDeposit(slots: BidSlot[]): FinalizeDeposit {
  const inputLen = slots.length ? estimateInputLen(slots) : 0;
  const required = outlayerRequiredDeposit(inputLen, slots.length);
  return { required, recommended: recommendedDeposit(required), inputLen, source: "estimate" };
}
