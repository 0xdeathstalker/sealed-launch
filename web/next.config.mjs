import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Optional ../deployments.json (written by the deploy scripts). Accepted keys (all optional):
//   { "network": "testnet", "factory": "...", "rpc": "...", "explorer": "...",
//     "outlayerProject": "owner/project", "codeHash": "<64 hex>" }
// Explicit NEXT_PUBLIC_* env vars always win over the file.
let dep = {};
try {
  dep = JSON.parse(fs.readFileSync(path.join(here, "..", "deployments.json"), "utf8"));
} catch {
  /* not deployed yet: defaults apply */
}
const pick = (envName, ...keys) => {
  if (process.env[envName]) return process.env[envName];
  for (const k of keys) if (typeof dep[k] === "string" && dep[k]) return dep[k];
  return "";
};

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["sealedlaunch-clearing"],
  outputFileTracingRoot: path.join(here, ".."),
  env: {
    NEXT_PUBLIC_FACTORY: pick("NEXT_PUBLIC_FACTORY", "factory", "factory_id"),
    NEXT_PUBLIC_RPC_URL: pick("NEXT_PUBLIC_RPC_URL", "rpc"),
    NEXT_PUBLIC_EXPLORER_URL: pick("NEXT_PUBLIC_EXPLORER_URL", "explorer"),
    NEXT_PUBLIC_OUTLAYER_PROJECT: pick("NEXT_PUBLIC_OUTLAYER_PROJECT", "outlayerProject", "outlayer_project"),
    NEXT_PUBLIC_CODE_HASH: pick("NEXT_PUBLIC_CODE_HASH", "codeHash", "code_hash"),
    NEXT_PUBLIC_DEPLOYMENTS_FOUND: Object.keys(dep).length ? "1" : "",
  },
};
