import { getSequelize } from "@reales/database";
import { listTemplates } from "@reales/domain";
import { can, hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewTemplateForm } from "./new-template-form";
import { ApproveButtons } from "./approve-buttons";

export const metadata = { title: "Templates | Reales CRM" };

export default async function Templates() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "template.read")) return <NoAccess />;
  const templates: any[] = await listTemplates(getSequelize(), ctx);
  return (
    <section>
      <h1 className="text-2xl font-semibold">Templates</h1>
      <p className="muted text-sm">Email, WhatsApp and SMS each have their own editor. WhatsApp templates need a second person to approve them.</p>
      {can(ctx, "template.manage") && <NewTemplateForm />}
      <div className="card mt-4 overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Channel</th><th>Purpose</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}><td>{t.name}</td><td>{t.channel}</td><td>{t.purpose ?? "-"}</td><td>{t.status}</td><td>{t.status === "draft" && can(ctx, "template.approve") ? <ApproveButtons id={t.id} /> : null}</td></tr>
            ))}
            {templates.length === 0 && <tr><td colSpan={5} className="muted">No templates yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
