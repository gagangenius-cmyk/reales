import { installStarterChecklists, listChecklistTemplates, saveChecklistTemplate } from "@reales/domain";
import { checklistTemplateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ templates: await listChecklistTemplates(sq, ctx) }));
export const POST = api({ body: checklistTemplateSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await saveChecklistTemplate(sq, ctx, body) }));
export const PUT = api({ body: z.object({ starter: z.literal(true) }).strict() }, async ({ ctx, sq }) => installStarterChecklists(sq, ctx));
