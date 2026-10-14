import { getSequelize } from "@reales/database";
import { listAgentDirectory, listCommissionPlans, listCommissions } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { CommissionActions, PlanForm } from "./commission-actions";

export const metadata = { title: "Commissions | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function Commissions({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "commission.read")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const manage = hasPermission(ctx, "commission.plan.manage");
  const [all, plans, agents] = await Promise.all([
    listCommissions(sq, ctx, { limit: 200, offset: 0 }) as Promise<any[]>,
    manage ? (listCommissionPlans(sq, ctx) as Promise<any[]>) : Promise.resolve([]),
    manage ? listAgentDirectory(sq, ctx) : Promise.resolve([]),
  ]);
  const email = new Map(agents.map((a) => [a.userId, a.email]));
  const rows = sp.type === "internal" || sp.type === "external" ? all.filter((c) => (c.agentType ?? "internal") === sp.type) : all;
  const sum = (f: (c: any) => boolean) => rows.filter(f).reduce((a, c) => a + Number(c.commissionAmount), 0);
  const cards = [
    ["Awaiting approval", sum((c) => c.status === "calculated")], ["Approved, unpaid", sum((c) => c.status === "approved" && !c.paidAt)],
    ["Paid", sum((c) => !!c.paidAt)], ["VAT on commission", rows.filter((c) => c.status !== "void").reduce((a, c) => a + Number(c.vatAmount ?? 0), 0)],
  ] as const;
  const canApprove = hasPermission(ctx, "commission.approve");
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head">
        <div><h1>Commissions</h1><p className="muted text-sm">Calculated automatically when a deal closes, by the agent&apos;s type and plan. Approval and payout need a fresh second factor.</p></div>
        <nav className="flex gap-2 text-sm" aria-label="Agent type">
          {[["", "All"], ["internal", "Internal"], ["external", "External"]].map(([v, l]) => <a key={v} href={v ? `?type=${v}` : "?"} className={(sp.type ?? "") === v ? "btn" : "btn-ghost"}>{l}</a>)}
        </nav>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([l, v]) => <div key={l} className="card stat"><span className="muted text-xs">{l}</span><b>{money(v)}</b></div>)}</div>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Date</th><th>Agent</th><th>Type</th><th>Deal value</th><th>Commission</th><th>VAT</th><th>Status</th><th>Splits</th><th /></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.calculatedAt).toISOString().slice(0, 10)}</td><td>{email.get(c.agentUserId) ?? (c.agentUserId ? "Agent" : "-")}</td>
                <td><span className={`badge ${c.agentType === "external" ? "badge-warn" : ""}`}>{c.agentType ?? "internal"}</span></td>
                <td>{money(c.grossAmount, c.currency)}</td><td>{money(c.commissionAmount, c.currency)}</td><td>{money(c.vatAmount ?? 0, c.currency)}</td>
                <td><span className={`badge ${c.paidAt ? "badge-ok" : c.status === "approved" ? "" : c.status === "void" ? "badge-gray" : "badge-warn"}`}>{c.paidAt ? "paid" : c.status}</span>{c.paidReference && <span className="muted block text-xs">{c.paidReference}</span>}</td>
                <td className="text-xs">{c.splits.map((s: any) => `${s.role} ${Number(s.pct)}% (${Number(s.amount).toLocaleString("en-US")})`).join(", ")}</td>
                <td className="text-right"><CommissionActions id={c.id} status={c.status} paid={!!c.paidAt} canApprove={canApprove} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No commissions yet. They appear when a deal reaches Closed.</td></tr>}
          </tbody>
        </table>
      </div>
      {manage && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Commission plans</h2>
          <div className="card overflow-x-auto">
            <table className="t">
              <thead><tr><th>Plan</th><th>Deal type</th><th>Applies to</th><th>Rate</th><th>VAT</th><th>Splits</th></tr></thead>
              <tbody>
                {plans.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.dealType}</td><td><span className="badge">{p.agentType ?? "any"}</span></td><td>{Number(p.ratePct)}%</td><td>{Number(p.vatPct ?? 5)}%</td><td>{(p.splits ?? []).map((s: any) => `${s.role} ${s.pct}%`).join(", ")}</td></tr>)}
                {plans.length === 0 && <tr><td colSpan={6} className="muted">No plans. Without a plan no commission is calculated.</td></tr>}
              </tbody>
            </table>
          </div>
          <PlanForm />
        </div>
      )}
    </section>
  );
}
