import { createLead, listLeads } from "@reales/domain";
import { leadListQuery, leadSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: leadListQuery }, async ({ ctx, sq, query }) => ({ leads: await listLeads(sq, ctx, query) }));
export const POST = api({ body: leadSchema, idempotent: true }, async ({ ctx, sq, body }) => {
  const r = await createLead(sq, ctx, body);
  return { status: r.duplicate ? 200 : 201, data: r };
});
