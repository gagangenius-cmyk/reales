import { getSequelize } from "@reales/database";
import { listSavedSearches } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { SearchForm, SearchRow } from "./search-client";

export const metadata = { title: "Saved searches | Reales CRM" };

export default async function Searches() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "match.read")) return <NoAccess />;
  const searches: any[] = await listSavedSearches(getSequelize(), ctx);
  const canManage = hasPermission(ctx, "match.manage");
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Saved searches</h1>
      <p className="muted text-sm">Save a client's requirements. You are notified when a newly published listing fits.</p>
      {canManage && <SearchForm />}
      <div className="flex flex-col gap-3">
        {searches.map((s) => <SearchRow key={s.id} id={s.id} name={s.name} status={s.status} criteria={s.criteria} canManage={canManage && s.ownerUserId === ctx.userId} />)}
        {searches.length === 0 && <p className="muted text-sm">No saved searches yet.</p>}
      </div>
    </section>
  );
}
