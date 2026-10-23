import { getSequelize } from "@reales/database";
import { getPayrollRun, listPayrollRuns } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { PayrollClient } from "./payroll-client";

export const metadata = { title: "Payroll | Reales CRM" };

export default async function Payroll({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "hr.salary")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const runs = await listPayrollRuns(sq, ctx);
  const current = sp.run ?? (runs[0] as any)?.id;
  const detail = current ? await getPayrollRun(sq, ctx, current).catch(() => null) : null;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Payroll</h1><p className="muted text-sm">Build a month from salaries, leave and attendance, adjust it, approve it (second factor needed), then mark it paid so employees can open their payslips. This prepares pay; it does not move money.</p></div></div>
      <PayrollClient runs={runs as never} detail={detail as never} />
    </section>
  );
}
