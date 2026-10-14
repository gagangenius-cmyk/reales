import { getSequelize } from "@reales/database";
import { listRoles, listUserRoles, listUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { InviteForm, ResendInvite } from "./invite-form";
import { UserRoles } from "./user-roles";

export const metadata = { title: "Users | Reales CRM" };

export default async function Users() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "user.read")) return <NoAccess />;
  const users: any[] = await listUsers(getSequelize(), ctx, { limit: 100, offset: 0 });
  const canInvite = hasPermission(ctx, "user.create") && hasPermission(ctx, "role.read");
  const canSeeRoles = hasPermission(ctx, "role.read");
  const roles: any[] = canSeeRoles ? ((await listRoles(getSequelize(), ctx).catch(() => [])) as any[]) : [];
  const held = canSeeRoles ? await listUserRoles(getSequelize(), ctx).catch(() => []) : [];
  return (
    <section>
      <h1 className="text-2xl font-semibold">Users</h1>
      {canInvite && roles.length > 0 && <div className="mt-4"><InviteForm roles={roles.filter((r) => r.key !== "tenant_admin").map((r) => ({ key: r.key, name: r.name }))} /></div>}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Email</th><th>Roles</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => <tr key={u.id}><td>{u.email}</td><td>{canSeeRoles ? <UserRoles userId={u.id} held={held.filter((h) => h.userId === u.id)} roles={roles.filter((r) => r.key !== "tenant_admin" || hasPermission(ctx, "role.manage")).map((r) => ({ key: r.key, name: r.name }))} canManage={hasPermission(ctx, "role.manage")} /> : "-"}</td><td><span className={`badge ${u.status === "active" ? "badge-ok" : u.status === "invited" ? "badge-warn" : "badge-gray"}`}>{u.status}</span></td><td>{u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 16).replace("T", " ") : "never"}</td><td>{u.status === "invited" && hasPermission(ctx, "user.create") && <ResendInvite userId={u.id} />}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
