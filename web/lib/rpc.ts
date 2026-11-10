import { RPC_URL } from "./config";

let rid = 0;
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) {
    const msg = j.error.data?.toString?.() ?? j.error.message ?? "RPC error";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const r = j.result;
  if (r && typeof r === "object" && "error" in r && r.error) throw new Error(String(r.error));
  return r as T;
}

/** NEAR view call; args are JSON, result is parsed JSON. */
export async function viewCall<T>(contract: string, method: string, args: unknown = {}): Promise<T> {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: argsBase64,
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

export async function viewAccessKeys(account: string): Promise<{ keys: unknown[] }> {
  return rpc("query", { request_type: "view_access_key_list", finality: "optimistic", account_id: account });
}
export async function viewAccountExists(account: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "optimistic", account_id: account });
    return true;
  } catch {
    return false;
  }
}
