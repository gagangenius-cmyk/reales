import { getSequelize } from "@reales/database";
import { listAllDocuments, listFolders } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { LibraryClient } from "./library-client";

export const metadata = { title: "Documents | Reales CRM" };

export default async function Documents({ searchParams }: { searchParams: Promise<{ folder?: string; q?: string; expiring?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "document.read") && !hasPermission(ctx, "document.manage")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const manage = ctx.grants.some((g) => g.permission === "document.manage" && g.scope === "tenant");
  const [folders, docs] = await Promise.all([listFolders(sq, ctx), listAllDocuments(sq, ctx, { folderId: sp.folder, q: sp.q, expiringWithinDays: sp.expiring ? Number(sp.expiring) : undefined })]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Documents</h1><p className="muted text-sm">Every document you can open, in folders with their own rules: who may see them, when they expire and how long they must be kept.</p></div></div>
      <LibraryClient folders={folders as never} docs={docs as never} canManage={manage} folder={sp.folder} q={sp.q} expiring={sp.expiring} />
    </section>
  );
}
