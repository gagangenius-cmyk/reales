import { listViews, saveView } from "@reales/domain";
import { savedViewQuery, savedViewSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: savedViewQuery }, async ({ ctx, sq, query }) => ({ views: await listViews(sq, ctx, query.entity) }));
export const POST = api({ body: savedViewSchema }, async ({ ctx, sq, body }) => ({ status: body.id ? 200 : 201, data: await saveView(sq, ctx, body) }));
