"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FACTORY, MOCK } from "@/lib/config";
import { useWallet } from "@/lib/wallet";

export function Header() {
  const w = useWallet();
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");
  useEffect(() => {
    try {
      const t = localStorage.getItem("sl:theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch { /* storage blocked */ }
  }, []);
  useEffect(() => {
    const r = document.documentElement;
    if (theme === "auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", theme);
    try { if (theme === "auto") localStorage.removeItem("sl:theme"); else localStorage.setItem("sl:theme", theme); } catch { /* ignore */ }
  }, [theme]);
  const next = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";

  return (
    <>
      {MOCK ? (
        <div className="banner">MOCK MODE: in-memory data, no wallet, no chain. Real crypto from clearing-js, fake network. Nothing here is on NEAR.</div>
      ) : null}
      <header className="top">
        <div className="wrap">
          <Link href="/" className="brand"><span className="logo" />SealedLaunch</Link>
          <nav className="nav">
            <Link href="/">Sales</Link>
            <Link href="/create">Create</Link>
          </nav>
          <div className="right">
            <span className="muted small" title="Factory contract">{MOCK ? "mock" : "testnet"}: {FACTORY}</span>
            <button className="btn sm" onClick={() => setTheme(next)} title="Toggle theme">Theme: {theme}</button>
            {MOCK ? (
              <select aria-label="Mock account" value={w.account ?? ""} onChange={(e) => w.setMockAccount(e.target.value)} style={{ width: "auto" }}>
                {w.mockAccounts.map((a) => <option key={a}>{a}</option>)}
              </select>
            ) : w.account ? (
              <>
                <span className="mono small">{w.account}</span>
                <button className="btn sm" onClick={() => w.disconnect()}>Disconnect</button>
              </>
            ) : (
              <button className="btn primary sm" onClick={w.connect} disabled={!w.ready}>{w.ready ? "Connect wallet" : "Loading wallet…"}</button>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
