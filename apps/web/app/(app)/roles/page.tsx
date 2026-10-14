import { getSequelize } from "@reales/database";
import { listRoles, permissionCatalogue } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { RoleEditor } from "./role-editor";

export const metadata = { title: "Roles & permissions | Reales CRM" };

export default async function Roles() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "role.read")) return <NoAccess />;
  const raw = (await listRoles(getSequelize(), ctx)) as any[];
  const roles = raw.map((r) => ({
    id: r.id as string, key: r.key as string, name: r.name as string, isSystem: !!r.isSystem, requiresMfa: !!r.requiresMfa,
    grants: Object.fromEntries(String(r.grants ?? "").split(",").filter(Boolean).map((g) => { const i = g.lastIndexOf(":"); return [g.slice(0, i), g.slice(i + 1)]; })) as Record<string, string>,
  }));
  return (
    <section>
      <div className="page-head"><div><h1>Roles &amp; permissions</h1><p className="muted text-sm">Pick what each role can do in every module and how widely (own records, branch, everything). Assign roles to users on the Users page.</p></div></div>
      <RoleEditor roles={roles} modules={permissionCatalogue()} canManage={hasPermission(ctx, "role.manage")} />
    </section>
  );
}
