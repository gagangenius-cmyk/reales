import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listTrash, TRASH_ENTITIES } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { LiveSearch } from "@/components/live-search";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { TrashTable } from "./trash-client";

export const metadata = { title: "Trash | Reales CRM" };
const PAGE = 50;

export default async function Trash({ searchParams }: { searchParams: Promise<{ entity?: string; q?: string; page?: string }> }) {
  const ctx = await requireContext();
  const kinds = Object.entries(TRASH_ENTITIES).filter(([, e]) => hasPermission(ctx, e.perm));
  if (kinds.length === 0) return <NoAccess />;
  const sp = await searchParams;
  const entity = kinds.some(([k]) => k === sp.entity) ? sp.entity : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const res = await listTrash(getSequelize(), ctx, { entity, q: sp.q?.trim() || undefined, limit: PAGE, offset: (page - 1) * PAGE });
  const pages = Math.max(1, Math.ceil(res.total / PAGE));
  const href = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ entity, q: sp.q, ...o })) if (v) p.set(k, v); return `/trash${p.toString() ? `?${p}` : ""}`; };
  return (
    <section className="flex flex-col gap-4">
      <div className="page-head"><div><h1>Trash</h1><p className="muted text-sm">Deleted records stay here and can be restored. {can(ctx, "tenant.manage") ? "Only administrators can erase them for good." : "You see what you deleted, plus anything your role manages."}</p></div></div>
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <label className="grow text-sm"><span className="muted text-xs font-medium">Search</span><div className="mt-1"><LiveSearch placeholder="Name or title" /></div></label>
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Record type">
          <Link className={entity ? "btn-ghost" : "btn"} href={href({ entity: undefined, page: undefined })}>All</Link>
          {kinds.map(([k, e]) => <Link key={k} className={entity === k ? "btn" : "btn-ghost"} href={href({ entity: k, page: undefined })}>{e.plural}</Link>)}
        </nav>
      </div>
      <TrashTable rows={res.rows} canPurge={can(ctx, "tenant.manage")} />
      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="muted">Page {page} of {pages} ({res.total} records)</span>
          <div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={href({ page: String(page - 1) })}>Previous</Link>}{page < pages && <Link className="btn-ghost" href={href({ page: String(page + 1) })}>Next</Link>}</div>
        </nav>
      )}
    </section>
  );
}
