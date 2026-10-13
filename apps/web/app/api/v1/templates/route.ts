import { createTemplate, listTemplates } from "@reales/domain";
import { createTemplateSchema, templateListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: templateListQuery }, async ({ ctx, sq, query }) => ({ templates: await listTemplates(sq, ctx, query) }));
export const POST = api({ body: createTemplateSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createTemplate(sq, ctx, body) }));
