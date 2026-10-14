import { getSequelize } from "@reales/database";
import { listLeads, listPartners, listReferrals } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { PartnerForm, ReferralActions, ReferralForm } from "./referral-client";

export const metadata = { title: "Referrals | Reales CRM" };

const aed = (v: unknown, c = "AED") => (v == null ? "-" : `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

export default async function Referrals() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "referral.read")) return <NoAccess />;
  const sq = getSequelize();
  const manage = hasPermission(ctx, "referral.manage");
  const settle = hasPermission(ctx, "referral.settle");
  const [partners, referrals, leads] = await Promise.all([
    listPartners(sq, ctx) as Promise<any[]>,
    listReferrals(sq, ctx, { limit: 100, offset: 0 }) as Promise<any[]>,
    manage ? (listLeads(sq, ctx, { limit: 100, offset: 0 } as any).catch(() => []) as Promise<any[]>) : Promise.resolve([]),
  ]);
  const pname = new Map(partners.map((p) => [p.id, p.name]));
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Referrals</h1>
      {manage && <PartnerForm />}
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Partners</h2>
        <table className="t">
          <thead><tr><th>Name</th><th>Type</th><th>Fee on our commission</th><th>Status</th></tr></thead>
          <tbody>
            {partners.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.kind}</td><td>{Number(p.feePct)}%</td><td>{p.status}</td></tr>)}
            {partners.length === 0 && <tr><td colSpan={4} className="muted">No partners yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {manage && partners.length > 0 && <ReferralForm partners={partners.filter((p) => p.status === "active").map((p) => ({ id: p.id, label: `${p.name} (${Number(p.feePct)}%)` }))} leads={leads.map((l: any) => ({ id: l.id, label: `${l.purpose} lead ${String(l.id).slice(0, 8)}` }))} />}
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Referred leads</h2>
        <table className="t">
          <thead><tr><th>Partner</th><th>Lead</th><th>Fee %</th><th>Status</th><th>Fee</th><th /></tr></thead>
          <tbody>
            {referrals.map((r) => (
              <tr key={r.id}>
                <td>{pname.get(r.partnerId) ?? "-"}</td><td>{String(r.leadId).slice(0, 8)}</td><td>{Number(r.feePct)}%</td><td>{r.status}</td><td>{aed(r.feeAmount, r.currency)}</td>
                <td><ReferralActions id={r.id} status={r.status} canManage={manage} canSettle={settle} /></td>
              </tr>
            ))}
            {referrals.length === 0 && <tr><td colSpan={6} className="muted">No referrals visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
