import { getSequelize } from "@reales/database";
import { listChecklistTemplates } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { InstallStarters, TemplateActions, TemplateEditor, type Template } from "./template-editor";

export const metadata = { title: "Deal checklists | Reales CRM" };

export default async function Checklists() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "deal.checklist.manage")) return <NoAccess />;
  const templates = (await listChecklistTemplates(getSequelize(), ctx)) as any[];
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Deal checklists</h1><p className="muted text-sm">The documents and steps every deal needs. They are copied onto each new deal, can block a stage until done, and any waiver needs a reason and a manager.</p></div>
        <div className="flex flex-wrap items-center gap-3"><InstallStarters /><TemplateEditor /></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {templates.map((t) => (
          <div key={t.id} className="card p-4" style={{ opacity: t.active ? 1 : 0.6 }}>
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="font-semibold">{t.name}</h2><p className="muted text-xs">{t.dealType} &middot; {t.projectKind === "any" ? "any property" : t.projectKind.replace("_", "-")} &middot; {t.items.length} items{!t.active && " · inactive"}</p></div>
              <div className="flex gap-2"><TemplateEditor template={{ id: t.id, name: t.name, dealType: t.dealType, projectKind: t.projectKind, active: !!t.active, items: t.items.map((i: any) => ({ title: i.title, guidance: i.guidance, required: !!i.required, gateStage: i.gateStage, dueOffsetDays: i.dueOffsetDays })) } as Template} /><TemplateActions id={t.id} /></div>
            </div>
            <ol className="mt-3 flex flex-col gap-1 text-sm">
              {t.items.map((i: any) => <li key={i.id} className="flex items-center justify-between gap-2"><span>{i.title}{!i.required && <span className="muted"> (optional)</span>}</span>{i.gateStage !== "none" && <span className="badge badge-gray">before {i.gateStage}</span>}</li>)}
            </ol>
          </div>
        ))}
        {templates.length === 0 && <p className="muted text-sm">No checklists yet. Add the UAE starter set, then edit it to match your own process. These are starting points, not legal advice: confirm requirements with your compliance officer.</p>}
      </div>
    </section>
  );
}
