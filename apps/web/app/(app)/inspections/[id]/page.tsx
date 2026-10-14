import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getInspection } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { InspectionEditor } from "./inspection-editor";

export const metadata = { title: "Inspection | Reales CRM" };

export default async function InspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "inspection.read")) return <NoAccess />;
  const { id } = await params;
  let i: any;
  try { i = await getInspection(getSequelize(), ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Inspection not found</h1><Link className="btn-ghost mt-3 inline-block" href="/inspections">Back</Link></section>;
  }
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/inspections">Back to inspections</Link>
        <h1 className="text-2xl font-semibold">{String(i.kind).replace("_", "-")} inspection</h1>
        <p className="muted text-sm">Status <strong>{i.status}</strong> - version {i.version}{i.summary ? ` - ${i.summary}` : ""}</p>
      </div>
      <InspectionEditor id={i.id} status={i.status} version={i.version} items={i.items.map((x: any) => ({ id: x.id, label: x.label, area: x.area, condition: x.condition, notes: x.notes ?? "", meterReading: x.meterReading }))} canPerform={hasPermission(ctx, "inspection.perform")} />
    </section>
  );
}
