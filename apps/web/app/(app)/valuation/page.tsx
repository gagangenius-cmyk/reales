import { getSequelize } from "@reales/database";
import { listUnits } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ValuationForm } from "./valuation-form";

export const metadata = { title: "Valuation | Reales CRM" };

export default async function Valuation() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "valuation.run")) return <NoAccess />;
  const units: any[] = await listUnits(getSequelize(), ctx, { limit: 200, offset: 0 }).catch(() => []) as any[];
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Valuation</h1>
      <p className="muted text-sm">A quick price indication from comparable closed deals and current asking prices in the same community. It is not a certified valuation.</p>
      <ValuationForm units={units.map((u) => ({ id: u.id, label: `Unit ${u.unitNumber} - ${u.bedrooms ?? "?"} bed, ${u.areaSqft ?? "?"} sq ft` }))} />
    </section>
  );
}
