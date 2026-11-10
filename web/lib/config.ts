// NEXT_PUBLIC_* must be referenced literally so Next can inline them.
export const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
export const INTENTS = process.env.NEXT_PUBLIC_INTENTS === "1";
export const NETWORK = "testnet" as const;
export const FACTORY = process.env.NEXT_PUBLIC_FACTORY || "sealedlaunch.deathstalker-sl.testnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://test.rpc.fastnear.com";
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.nearblocks.io";
export const OUTLAYER_PROJECT = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT || "deathstalker-sl.testnet/sealedlaunch";
// From contracts/sale/NOTES.md (build 607df359...). Override when the worker is rebuilt.
export const CODE_HASH =
  process.env.NEXT_PUBLIC_CODE_HASH || "607df359c7c0f340aba2cc9cc0eabefbb2785466f395855b839e2568195307b6";
export const DEPLOYMENTS_FOUND = process.env.NEXT_PUBLIC_DEPLOYMENTS_FOUND === "1";

export const explorerAccount = (id: string) => `${EXPLORER_URL}/address/${id}`;
export const explorerTx = (hash: string) => `${EXPLORER_URL}/txns/${hash}`;

export const TGAS = 10n ** 12n;
