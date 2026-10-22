import { timesheet } from "@reales/domain";
import { rangeQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: rangeQuery }, async ({ ctx, sq, query }) => {
  let id = query.employeeId;
  if (!id) { const { myEmployee } = await import("@reales/domain"); id = (await myEmployee(sq, ctx))?.id; }
  if (!id) return { employee: null, days: [], summary: null };
  return timesheet(sq, ctx, id, query.from, query.to);
});
