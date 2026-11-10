"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FACTORY, MOCK, NETWORK } from "./config";
import { MOCK_ACCOUNTS, mockExec } from "./mock";
import type { TxCall, TxResult } from "./types";

interface WalletCtx {
  account: string | null;
  ready: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  call: (c: TxCall) => Promise<TxResult>;
  mockAccounts: string[];
  setMockAccount: (a: string) => void;
}
const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => useContext(Ctx) ?? (() => { throw new Error("WalletProvider missing"); })();

// Minimal structural types so we do not depend on the selector's internal type exports.
interface SelectorLike {
  wallet: () => Promise<{
    signAndSendTransaction: (p: unknown) => Promise<{ transaction?: { hash?: string } } | void>;
    signOut: () => Promise<void>;
  }>;
  isSignedIn: () => boolean;
  store: { getState: () => { accounts: { accountId: string; active: boolean }[] }; observable: { subscribe: (f: (s: { accounts: { accountId: string; active: boolean }[] }) => void) => { unsubscribe: () => void } } };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string | null>(MOCK ? MOCK_ACCOUNTS[0] : null);
  const [ready, setReady] = useState(MOCK);
  const selector = useRef<SelectorLike | null>(null);
  const modal = useRef<{ show: () => void } | null>(null);

  useEffect(() => {
    if (MOCK) return;
    let sub: { unsubscribe: () => void } | undefined;
    let dead = false;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
      ]);
      // @ts-expect-error - stylesheet side-effect import has no types
      await import("@near-wallet-selector/modal-ui/styles.css");
      const sel = await setupWalletSelector({ network: NETWORK, modules: [setupMyNearWallet()] });
      if (dead) return;
      selector.current = sel as unknown as SelectorLike;
      modal.current = setupModal(sel, { contractId: FACTORY });
      const pick = (s: { accounts: { accountId: string; active: boolean }[] }) =>
        setAccount(s.accounts.find((a) => a.active)?.accountId ?? s.accounts[0]?.accountId ?? null);
      pick(sel.store.getState());
      sub = sel.store.observable.subscribe(pick);
      setReady(true);
    })().catch((e) => console.error("wallet selector failed to load", e));
    return () => { dead = true; sub?.unsubscribe(); };
  }, []);

  const connect = useCallback(() => { modal.current?.show(); }, []);
  const disconnect = useCallback(async () => {
    if (MOCK) return;
    const w = await selector.current?.wallet();
    await w?.signOut();
    setAccount(null);
  }, []);

  const call = useCallback(async (c: TxCall): Promise<TxResult> => {
    if (!account) throw new Error("Connect a wallet first");
    if (MOCK) return mockExec(account, c);
    const w = await selector.current!.wallet();
    const out = await w.signAndSendTransaction({
      receiverId: c.receiverId,
      actions: [{ type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: c.gas.toString(), deposit: c.deposit.toString() } }],
    });
    // Browser wallets (MyNearWallet) redirect away and return nothing.
    return out ? { txHash: out.transaction?.hash } : { redirected: true };
  }, [account]);

  const value = useMemo<WalletCtx>(() => ({
    account, ready, connect, disconnect, call, mockAccounts: MOCK_ACCOUNTS, setMockAccount: setAccount,
  }), [account, ready, connect, disconnect, call]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
