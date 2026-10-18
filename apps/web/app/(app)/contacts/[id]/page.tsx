import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getContact, leadsForContact } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { ContactDrawer } from "../contact-drawer";

export const metadata = { title: "Contact | Reales CRM" };

const nice = (v: unknown) => (v ? String(v).replace(/_/g, " ") : "-");

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "contact.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let c: any;
  try { c = await getContact(sq, ctx, id); } catch { return <section><h1 className="text-2xl font-semibold">Contact not found</h1><Link className="btn-ghost mt-3 inline-block" href="/contacts">Back to contacts</Link></section>; }
  const leads: any[] = hasPermission(ctx, "lead.read") ? await leadsForContact(sq, ctx, id).catch(() => []) : [];
  const name = [c.salutation, c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || "Unnamed";
  const canEdit = can(ctx, "contact.update", { ownerUserId: c.ownerUserId, branchId: c.branchId });
  const facts: [string, string][] = [
    ["Phone", c.phoneE164 ?? "-"], ["Second phone", c.phoneSecondary ?? "-"], ["WhatsApp", c.whatsappE164 ?? "-"], ["Email", c.email ?? "-"],
    ["Prefers", `${nice(c.preferredChannel)}${c.preferredContactTime ? `, ${c.preferredContactTime}` : ""}`], ["Language", c.language ?? "-"],
    ["Nationality", c.nationality ?? "-"], ["Residency", nice(c.residency)], ["Gender", nice(c.gender)], ["Date of birth", c.dateOfBirth ?? "-"],
    ["Job", [c.jobTitle, c.employer].filter(Boolean).join(" at ") || "-"], ["Location", [c.addressLine, c.city, c.country].filter(Boolean).join(", ") || "-"],
  ];
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><Link className="muted text-sm" href="/contacts">&larr; Contacts</Link><h1>{name}</h1><p className="muted text-sm">{c.type === "company" ? "Company" : "Person"} &middot; added {new Date(c.createdAt).toISOString().slice(0, 10)}{c.lastContactedAt ? ` · last contacted ${new Date(c.lastContactedAt).toISOString().slice(0, 10)}` : ""}</p></div>
        {canEdit && <ContactDrawer id={c.id} initial={{ firstName: c.firstName ?? "", lastName: c.lastName ?? "", companyName: c.companyName ?? "", email: c.email ?? "", phone: c.phoneE164 ?? "", language: c.language ?? "en", nationality: c.nationality ?? "", salutation: c.salutation ?? "", gender: c.gender ?? "", dateOfBirth: c.dateOfBirth ?? "", jobTitle: c.jobTitle ?? "", employer: c.employer ?? "", phoneSecondary: c.phoneSecondary ?? "", whatsapp: c.whatsappE164 ?? "", addressLine: c.addressLine ?? "", city: c.city ?? "", country: c.country ?? "", residency: c.residency ?? "", preferredChannel: c.preferredChannel ?? "", preferredContactTime: c.preferredContactTime ?? "", tags: (c.tags ?? []).join(", "), notes: c.notes ?? "" }} />}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 font-semibold">Details</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">{facts.map(([k, v]) => <div key={k}><dt className="muted text-xs">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl>
          {(c.tags ?? []).length > 0 && <p className="mt-3">{c.tags.map((t: string) => <span key={t} className="badge mr-1">{t}</span>)}</p>}
          {c.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg p-3 text-sm" style={{ background: "var(--card-2)" }}>{c.notes}</p>}
          {hasPermission(ctx, "kyc.read") && <Link className="btn-ghost mt-4 inline-block text-sm" href={`/compliance/kyc/${c.id}`}>KYC and compliance</Link>}
        </div>
        <div className="card overflow-x-auto p-4">
          <h2 className="mb-3 font-semibold">Leads</h2>
          <table className="t">
            <thead><tr><th>Received</th><th>Purpose</th><th>Status</th><th /></tr></thead>
            <tbody>
              {leads.map((l) => <tr key={l.id}><td>{new Date(l.createdAt).toISOString().slice(0, 10)}</td><td>{l.isHot ? <span className="err">&#9650; </span> : null}{l.purpose}</td><td><span className={`badge ${l.status === "won" ? "badge-ok" : l.status === "lost" ? "badge-gray" : ""}`}>{l.status}</span></td><td className="text-right"><Link className="btn-ghost text-xs" href={`/leads/${l.id}`}>Open</Link></td></tr>)}
              {leads.length === 0 && <tr><td colSpan={4} className="muted">No leads for this contact.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
