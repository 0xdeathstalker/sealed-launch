"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { FACTORY, MOCK, DEPLOYMENTS_FOUND } from "@/lib/config";
import { usePoll } from "@/lib/hooks";
import { Note, Pill } from "@/components/ui";
import { formatUnits } from "@/lib/format";
import type { SaleInfo } from "@/lib/types";

function statusKind(s: SaleInfo): "ok" | "warn" | "bad" | undefined {
  if (s.refund_mode || s.voided) return "bad";
  if (s.status === "Bidding") return "ok";
  return undefined;
}

export default function Home() {
  const { data, error, loading } = usePoll(async () => {
    const ids = await api.listSales();
    const infos = await Promise.all(ids.map(async (id) => {
      try { return { id, info: await api.saleInfo(id) }; } catch { return { id, info: null }; }
    }));
    return infos;
  }, "list", 15000);

  return (
    <>
      <section className="hero">
        <h1>Token launches you can&apos;t snipe.</h1>
        <p>
          Bids are encrypted to a key that only a TEE can use. When the window closes everyone is cleared at one
          price, P*. A bot that bid first pays the same as you. The sale account has zero access keys, and you can
          recompute the result yourself from public data.
        </p>
        <div className="row"><Link className="btn primary" href="/create">Create a sale</Link></div>
      </section>
      <h2 style={{ marginTop: 28 }}>Sales</h2>
      {!MOCK && !DEPLOYMENTS_FOUND ? (
        <Note>No <code>deployments.json</code> found at build time; using the default factory <code>{FACTORY}</code>. The contracts may not be deployed yet.</Note>
      ) : null}
      {error ? <Note kind="bad">Could not list sales from <code>{FACTORY}</code>: {error}</Note> : null}
      {loading && !data ? <p className="muted">Loading…</p> : null}
      {data && data.length === 0 ? <p className="muted">No sales yet.</p> : null}
      <div className="salelist">
        {data?.map(({ id, info }) => (
          <Link key={id} href={`/sale/${id}`} className="card saleitem">
            <div>
              <strong>{info ? `${info.params.token_name} (${info.params.symbol})` : id}</strong>
              <div className="mono small muted">{id}</div>
            </div>
            <div className="row">
              {info ? (
                <>
                  <span className="small muted">{info.bid_count} bids · {formatUnits(BigInt(info.params.auction_supply), info.params.token_decimals, 0)} for sale</span>
                  <Pill kind={statusKind(info)}>{info.refund_mode ? "Refund" : info.status}</Pill>
                </>
              ) : <Pill kind="warn">unreadable</Pill>}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
