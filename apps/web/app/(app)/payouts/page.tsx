import { QueryTypes } from "sequelize";
import { getSequelize } from "@reales/database";
import { listPayable, listPayouts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { PayoutActions, RequestForm } from "./payout-client";

export const metadata = { title: "Payouts | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const tone: Record<string, string> = { pending: "badge-warn", approved: "", paid: "badge-ok", rejected: "badge-danger", cancelled: "badge-gray" };
const dt = (v: unknown) => (v ? new Date(v as string).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" }) : "-");

export default async function Payouts({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireContext();
  const decide = hasPermission(ctx, "commission.approve");
  const request = hasPermission(ctx, "payout.request");
  if (!decide && !request) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const [payable, rows]: [any[], any[]] = await Promise.all([request ? listPayable(sq, ctx) : Promise.resolve([]), listPayouts(sq, ctx, { status: sp.status }) as Promise<any[]>]);
  const [profile] = request ? await sq.query<{ agent_type: string }>("SELECT agent_type FROM agent_profiles WHERE tenant_id=:t AND user_id=:u", { replacements: { t: ctx.tenantId, u: ctx.userId }, type: QueryTypes.SELECT }) : [];
  const sum = (s: string) => rows.filter((r) => r.status === s).reduce((a, r) => a + Number(r.totalAmount), 0);
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>Payouts</h1><p className="muted text-sm">{decide ? "Review, approve and pay commission payout requests. Approval and payment need a fresh second factor, and nobody decides their own request." : "Request payment of your share of approved commissions."}</p></div></div>
      {decide && <div className="grid gap-3 sm:grid-cols-3"><div className="card stat"><span className="muted text-xs">Waiting for approval</span><b className="text-xl">{money(sum("pending"))}</b></div><div className="card stat"><span className="muted text-xs">Approved, to pay</span><b className="text-xl">{money(sum("approved"))}</b></div><div className="card stat"><span className="muted text-xs">Paid</span><b className="text-xl">{money(sum("paid"))}</b></div></div>}
      {request && <div className="flex flex-col gap-3"><h2 className="text-lg font-semibold">Available to request</h2><RequestForm payable={payable} external={profile?.agent_type === "external"} /></div>}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{decide ? "All requests" : "My requests"}</h2>
        <div className="card overflow-x-auto">
          <table className="t"><thead><tr>{decide && <th>Agent</th>}<th>Requested</th><th>Commissions</th><th>Net</th><th>VAT</th><th>Total</th><th>Status</th><th>Detail</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>{decide && <td className="font-medium">{r.agent}</td>}<td>{dt(r.requestedAt)}</td><td>{r.items.length}</td><td>{money(r.netAmount, r.currency)}</td><td>{money(r.vatAmount, r.currency)}</td><td className="font-medium">{money(r.totalAmount, r.currency)}</td>
                  <td><span className={`badge ${tone[r.status]}`}>{r.status}</span></td>
                  <td className="text-xs">{r.invoiceRef ? `Invoice ${r.invoiceRef}` : ""}{r.decisionReason ? ` · ${r.decisionReason}` : ""}{r.paidReference ? ` · Ref ${r.paidReference}` : ""}</td>
                  <td className="text-right"><PayoutActions id={r.id} status={r.status} mine={r.userId === ctx.userId} canDecide={decide} /></td></tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={decide ? 9 : 8} className="muted">No requests yet.</td></tr>}
            </tbody></table>
        </div>
      </div>
    </section>
  );
}
