import { getSequelize } from "@reales/database";
import { listCases, listContacts, listDsr, listKycProfiles } from "@reales/domain";
import Link from "next/link";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { KycJump } from "./kyc-jump";
import { DsrActions, DsrCreate } from "./dsr-client";
import { CaseActions, CaseCreate } from "./cases-client";

export const metadata = { title: "Compliance | Reales CRM" };

const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "-");

export default async function Compliance() {
  const ctx = await requireContext();
  const kycOk = hasPermission(ctx, "kyc.read");
  const casesOk = hasPermission(ctx, "case.read");
  const dsrOk = hasPermission(ctx, "dsr.manage");
  if (!kycOk && !casesOk && !dsrOk) return <NoAccess />;
  const sq = getSequelize();
  const contacts: any[] = (kycOk && hasPermission(ctx, "kyc.manage")) || dsrOk ? ((await listContacts(sq, ctx, { limit: 200, offset: 0 }).catch(() => [])) as any[]) : [];
  const [profiles, cases, dsr] = await Promise.all([
    kycOk ? (listKycProfiles(sq, ctx, { limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    casesOk ? (listCases(sq, ctx, { limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
    dsrOk ? (listDsr(sq, ctx, { status: "received", limit: 50, offset: 0 }) as Promise<any[]>) : Promise.resolve([]),
  ]);
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Compliance</h1>
      <p className="muted text-sm">Screening here uses a mock provider and illustrative risk weights; both need compliance-function review before production use.</p>
      {kycOk && hasPermission(ctx, "kyc.manage") && contacts.length > 0 && (
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <label className="grow text-sm">Open or start a KYC profile for<select className="input mt-1 w-full" id="kyc-contact">{contacts.map((c) => <option key={c.id} value={c.id}>{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id}</option>)}</select></label>
          <KycJump />
        </div>
      )}
      {kycOk && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">KYC profiles</h2>
          <table className="t">
            <thead><tr><th>Type</th><th>Status</th><th>Risk</th><th>PEP</th><th>ID</th><th>Expires</th></tr></thead>
            <tbody>
              {profiles.map((p) => <tr key={p.id}><td><Link className="underline" href={`/compliance/kyc/${p.contactId}`}>{p.subjectType}</Link></td><td>{p.status}</td><td>{p.riskLevel}{p.riskScore != null ? ` (${p.riskScore})` : ""}</td><td>{p.isPep ? "yes" : "no"}</td><td>{p.idNumberLast4 ? `...${p.idNumberLast4}` : "-"}</td><td>{p.expiresAt ?? "-"}</td></tr>)}
              {profiles.length === 0 && <tr><td colSpan={6} className="muted">No KYC profiles.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {casesOk && hasPermission(ctx, "case.manage") && <CaseCreate profiles={profiles.map((p) => ({ id: p.id, label: `${p.subjectType} - ${p.status}${p.riskLevel ? `, ${p.riskLevel} risk` : ""} (${String(p.contactId).slice(0, 8)})` }))} />}
      {casesOk && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Cases</h2>
          <table className="t">
            <thead><tr><th>Opened</th><th>Kind</th><th>Status</th><th>Summary</th><th>Outcome</th><th /></tr></thead>
            <tbody>
              {cases.map((c) => <tr key={c.id}><td>{day(c.createdAt)}</td><td>{c.kind}</td><td>{c.status}</td><td>{c.summary}</td><td>{c.outcome ?? "-"}</td><td>{hasPermission(ctx, "case.manage") && <CaseActions id={c.id} status={c.status} />}</td></tr>)}
              {cases.length === 0 && <tr><td colSpan={6} className="muted">No cases.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {dsrOk && contacts.length > 0 && <DsrCreate contacts={contacts.map((c) => ({ id: c.id, label: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id }))} />}
      {dsrOk && (
        <div className="card overflow-x-auto p-2">
          <h2 className="p-2 font-semibold">Open data-subject requests (soonest due first)</h2>
          <table className="t">
            <thead><tr><th>Kind</th><th>Received</th><th>Due</th><th /></tr></thead>
            <tbody>
              {dsr.map((r) => <tr key={r.id}><td>{r.kind}</td><td>{day(r.createdAt)}</td><td>{day(r.dueAt)}</td><td><DsrActions id={r.id} kind={r.kind} /></td></tr>)}
              {dsr.length === 0 && <tr><td colSpan={4} className="muted">Nothing outstanding.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
