"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface Polled<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Fetch now and then every `ms`. `key` changes restart it. */
export function usePoll<T>(fn: () => Promise<T>, key: string, ms = 10000): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let dead = false;
    const run = async () => {
      try {
        const v = await fnRef.current();
        if (!dead) { setData(v); setError(null); }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!dead) setLoading(false);
      }
    };
    run();
    const t = ms > 0 ? setInterval(run, ms) : undefined;
    return () => { dead = true; if (t) clearInterval(t); };
  }, [key, ms, tick]);
  return { data, error, loading, reload };
}
