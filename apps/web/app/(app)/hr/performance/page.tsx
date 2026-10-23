import { getSequelize } from "@reales/database";
import { cycleReviews, listReviewCycles } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { PerformanceClient } from "./performance-client";

export const metadata = { title: "Performance | Reales CRM" };

export default async function Performance({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const sq = getSequelize();
  const cycles: any[] = await listReviewCycles(sq, ctx);
  const current = cycles.find((c) => c.id === sp.cycle) ?? cycles.find((c) => c.status === "open") ?? cycles[0];
  const detail = current ? await cycleReviews(sq, ctx, current.id) : null;
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Performance reviews</h1><p className="muted text-sm">Set goals, write a self-assessment, get your manager&apos;s rating, then HR finalises. You see your manager&apos;s feedback once the review is final.</p></div></div>
      <PerformanceClient cycles={cycles} detail={detail as never} canManage={hasPermission(ctx, "hr.manage")} />
    </section>
  );
}
