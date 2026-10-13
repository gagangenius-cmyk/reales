import { createInspectionTemplate, listInspectionTemplates } from "@reales/domain";
import { inspectionTemplateSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ templates: await listInspectionTemplates(sq, ctx) }));
export const POST = api({ body: inspectionTemplateSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createInspectionTemplate(sq, ctx, body) }));
