import { getSequelize } from "@reales/database";
import { journal, trialBalance } from "@reales/domain";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";

export const metadata = { title: "Ledger | Reales CRM" };
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function Ledger({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireContext();
  if (!ctx.grants.some((g) => g.permission === "finance.read" && g.scope === "tenant")) return <NoAccess />;
  const sp = await searchParams;
  const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
  const to = sp.to && ymd.test(sp.to) ? sp.to : today, from = sp.from && ymd.test(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const sq = getSequelize();
  const [tb, entries] = await Promise.all([trialBalance(sq, ctx, to), journal(sq, ctx, { from, to })]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Ledger</h1><p className="muted text-sm">A general ledger worked out from invoices, payments and commissions, so it always agrees with the finance screens. Download the journal for your accounting package, or read the trial balance.</p></div></div>
      <form className="card flex flex-wrap items-end gap-3 p-3 text-sm" action="/ledger">
        <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">From</span><input className="input" type="date" name="from" defaultValue={from} /></label>
        <label className="flex flex-col gap-1.5"><span className="muted text-xs font-medium">To</span><input className="input" type="date" name="to" defaultValue={to} /></label>
        <button className="btn">Show</button>
        <a className="btn-ghost" href={`/api/v1/ledger/journal?from=${from}&to=${to}&format=csv`}>Download journal (CSV)</a>
      </form>
      <div className="card overflow-x-auto" data-server-table>
        <h2 className="p-4 pb-0 font-semibold">Trial balance as at {to}</h2>
        <table className="t"><thead><tr><th>Account</th><th>Currency</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
          <tbody>
            {tb.accounts.map((a) => <tr key={`${a.currency}-${a.account}`}><td>{a.account} {a.name}</td><td>{a.currency}</td><td>{money(a.debit)}</td><td>{money(a.credit)}</td><td className="font-medium">{money(a.balance)}</td></tr>)}
            {tb.totals.map((t) => <tr key={t.currency} className="font-semibold"><td>Total</td><td>{t.currency}</td><td>{money(t.debit)}</td><td>{money(t.credit)}</td><td>{t.debit === t.credit ? "balanced" : "OUT OF BALANCE"}</td></tr>)}
            {tb.accounts.length === 0 && <tr><td colSpan={5} className="muted">No postings yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto" data-server-table>
        <h2 className="p-4 pb-0 font-semibold">Journal {from} to {to} ({entries.length} entries)</h2>
        <table className="t"><thead><tr><th>Date</th><th>Reference</th><th>Memo</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
          <tbody>
            {entries.flatMap((e) => e.lines.map((l, i) => <tr key={`${e.sourceId}-${e.source}-${l.account}-${i}`}>{i === 0 ? <><td rowSpan={e.lines.length}>{e.date}</td><td rowSpan={e.lines.length}>{e.reference}</td><td rowSpan={e.lines.length}>{e.memo}</td></> : null}<td>{l.account} {l.accountName}</td><td>{l.debit ? `${e.currency} ${money(l.debit)}` : ""}</td><td>{l.credit ? `${e.currency} ${money(l.credit)}` : ""}</td></tr>))}
            {entries.length === 0 && <tr><td colSpan={6} className="muted">No entries in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
