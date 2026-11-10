"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { MOCK, explorerAccount } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { Pill } from "./ui";

/** Live RPC check: `view_access_key_list` for the account. A sale must show exactly 0 keys. */
export function KeyCheck({ account, watch = false }: { account: string; watch?: boolean }) {
  const [enabled, setEnabled] = useState(watch);
  const { data, error, loading, reload } = usePoll(
    async () => (enabled ? api.accessKeys(account) : null), `${account}:${enabled}`, watch ? 6000 : 0,
  );
  const link = (
    <a href={explorerAccount(account)} target="_blank" rel="noreferrer" className="small">explorer ↗</a>
  );
  return (
    <div className="row">
      {!enabled ? (
        <button className="btn sm" onClick={() => setEnabled(true)}>Check access keys</button>
      ) : loading && !data ? (
        <Pill>checking…</Pill>
      ) : error || data?.error ? (
        <Pill kind="warn">RPC error</Pill>
      ) : data && !data.exists ? (
        <Pill kind="warn">account does not exist (yet)</Pill>
      ) : data && data.keys === 0 ? (
        <Pill kind="ok">0 access keys</Pill>
      ) : data ? (
        <Pill kind="bad">{data.keys} access key(s): NOT keyless</Pill>
      ) : null}
      {enabled ? <button className="btn sm" onClick={reload}>Re-check</button> : null}
      {link}
      <span className="muted small">{MOCK ? "(mock RPC)" : "live RPC view_access_key_list"}</span>
      {(error || data?.error) ? <span className="small" style={{ color: "var(--bad)" }}>{error ?? data?.error}</span> : null}
    </div>
  );
}
