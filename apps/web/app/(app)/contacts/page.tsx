import { getSequelize } from "@reales/database";
import { listContacts } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewContactForm } from "./new-contact-form";

export const metadata = { title: "Contacts | Reales CRM" };

export default async function Contacts({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "contact.read")) return <NoAccess />;
  const { q } = await searchParams;
  const contacts: any[] = await listContacts(getSequelize(), ctx, { limit: 100, offset: 0, q: q?.slice(0, 100) });
  return (
    <section>
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <form className="mt-3 flex gap-2" role="search">
        <input className="input max-w-xs" name="q" defaultValue={q} placeholder="Search name, email or phone" aria-label="Search contacts" />
        <button className="btn-ghost">Search</button>
      </form>
      {can(ctx, "contact.create") && <NewContactForm />}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Language</th></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>{[c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "-"}</td>
                <td>{c.phoneE164 ?? "-"}</td><td>{c.email ?? "-"}</td><td>{c.language ?? "-"}</td>
              </tr>
            ))}
            {contacts.length === 0 && <tr><td colSpan={4} className="muted">No contacts visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
