import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listContacts } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ContactDrawer } from "./contact-drawer";

export const metadata = { title: "Contacts | Reales CRM" };
const PAGE = 25;

export default async function Contacts({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "contact.read")) return <NoAccess />;
  const { q, page: p } = await searchParams;
  const page = Math.max(1, Number(p) || 1);
  // One extra row tells us whether a next page exists.
  const rows: any[] = await listContacts(getSequelize(), ctx, { limit: PAGE + 1, offset: (page - 1) * PAGE, q: q?.slice(0, 100) });
  const contacts = rows.slice(0, PAGE);
  const qs = (n: number) => `?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;
  return (
    <section>
      <div className="page-head">
        <div><h1>Contacts</h1><p className="muted text-sm">Everyone you deal with: buyers, tenants, owners and companies.</p></div>
        {can(ctx, "contact.create") && <ContactDrawer />}
      </div>
      <form className="card mb-4 flex gap-2 p-3" role="search">
        <input className="input" name="q" defaultValue={q} placeholder="Search name, company, email or phone" aria-label="Search contacts" />
        <button className="btn">Search</button>{q && <Link className="btn-ghost" href="/contacts">Clear</Link>}
      </form>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Nationality</th><th>Prefers</th><th>Tags</th><th /></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td className="font-medium"><Link href={`/contacts/${c.id}`}>{[c.salutation, c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "-"}</Link>{c.type === "company" && <span className="badge badge-gray ml-2">company</span>}</td>
                <td>{c.phoneE164 ?? "-"}</td><td>{c.email ?? "-"}</td><td>{c.nationality ?? "-"}</td><td>{c.preferredChannel ?? "-"}</td>
                <td>{(c.tags ?? []).slice(0, 3).map((t: string) => <span key={t} className="badge mr-1">{t}</span>)}</td>
                <td className="text-right"><Link className="btn-ghost text-xs" href={`/contacts/${c.id}`}>Open</Link></td>
              </tr>
            ))}
            {contacts.length === 0 && <tr><td colSpan={7} className="muted">No contacts visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
      {(page > 1 || rows.length > PAGE) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page}</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={qs(page - 1)}>Previous</Link>}{rows.length > PAGE && <Link className="btn-ghost" href={qs(page + 1)}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
