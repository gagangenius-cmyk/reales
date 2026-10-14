import { getSequelize } from "@reales/database";
import { listTasks } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { TaskForm, TaskRow } from "./task-client";

export const metadata = { title: "Tasks | Reales CRM" };

export default async function Tasks({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requireContext();
  const { view } = await searchParams;
  const sq = getSequelize();
  const all = view === "team" && hasPermission(ctx, "lead.assign");
  const [open, done] = await Promise.all([listTasks(sq, ctx, { scope: all ? "all" : "mine", status: "open" }) as Promise<any[]>, listTasks(sq, ctx, { scope: all ? "all" : "mine", status: "done", limit: 20 }) as Promise<any[]>]);
  const overdue = open.filter((t) => t.overdue);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        {hasPermission(ctx, "lead.assign") && <a className="btn-ghost text-sm" href={all ? "/tasks" : "/tasks?view=team"}>{all ? "Show mine" : "Show whole team"}</a>}
      </div>
      <TaskForm />
      {overdue.length > 0 && <p role="status" className="err text-sm">{overdue.length} overdue</p>}
      <ul className="card divide-y">
        {open.map((t) => <TaskRow key={t.id} id={t.id} title={t.title} dueAt={t.dueAt} overdue={t.overdue} leadId={t.leadId} />)}
        {open.length === 0 && <li className="muted p-3 text-sm">Nothing open. Enjoy the quiet.</li>}
      </ul>
      {done.length > 0 && (
        <details className="card p-3 text-sm"><summary className="cursor-pointer font-medium">Recently completed ({done.length})</summary>
          <ul className="mt-2 space-y-1">{done.map((t) => <li key={t.id} className="muted line-through">{t.title}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
