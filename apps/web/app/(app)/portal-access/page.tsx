import { getSequelize } from "@reales/database";
import { listContacts, listPortalUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { InvitePortal, RevokePortal } from "./portal-client";

export const metadata = { title: "Portal access | Reales CRM" };

export default async function PortalAccess() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "portaluser.manage")) return <NoAccess />;
  const sq = getSequelize();
  const [users, contacts] = await Promise.all([listPortalUsers(sq, ctx), (listContacts(sq, ctx, { limit: 200, offset: 0 }).catch(() => [])) as Promise<any[]>]);
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Owner and tenant portal access</h1>
      <p className="muted text-sm">Give a landlord or tenant a login that shows only their own statements, leases, rent schedule and maintenance requests.</p>
      <InvitePortal contacts={contacts.map((c) => ({ id: c.id, label: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id }))} />
      <div className="card overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Person</th><th>Email</th><th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u: any) => <tr key={u.id}><td>{u.contact}</td><td>{u.email}</td><td>{u.kind}</td><td>{u.status}{u.userStatus === "invited" ? " (invite pending)" : ""}</td><td>{u.status === "active" && <RevokePortal id={u.id} />}</td></tr>)}
            {users.length === 0 && <tr><td colSpan={5} className="muted">No portal users yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
