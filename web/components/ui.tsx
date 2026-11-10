"use client";
import { useState, type ReactNode } from "react";
import { explorerAccount } from "@/lib/config";

export function Stat({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s ? <div className="s">{s}</div> : null}
    </div>
  );
}

export function Pill({ kind, children }: { kind?: "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`pill ${kind ?? ""}`}><span className="dot" />{children}</span>;
}

export function Note({ kind, children }: { kind?: "ok" | "warn" | "bad"; children: ReactNode }) {
  return <div className={`note ${kind ?? ""}`}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="f">
      <span className="l">{label}</span>
      {children}
      {hint ? <span className="h">{hint}</span> : null}
    </label>
  );
}

export function Unit({ unit, children }: { unit: string; children: ReactNode }) {
  return <div className="inp-unit">{children}<span className="u">{unit}</span></div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button" className="btn sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard blocked */ }
      }}
    >{done ? "Copied" : label}</button>
  );
}

export function AccountLink({ id }: { id: string }) {
  return <a href={explorerAccount(id)} target="_blank" rel="noreferrer" className="mono">{id}</a>;
}

/** Runs an async action, shows busy + error + result note. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<string | void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (...a: A) => {
    setBusy(true); setError(null); setMsg(null);
    try { const m = await fn(...a); if (m) setMsg(m); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return { run, busy, error, msg };
}
export function ActionStatus({ error, msg }: { error: string | null; msg: string | null }) {
  return <>{error ? <Note kind="bad">{error}</Note> : null}{msg ? <Note kind="ok">{msg}</Note> : null}</>;
}
