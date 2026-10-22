import { listLetterTemplates, saveLetterTemplate, LETTER_KINDS, VARIABLES } from "@reales/domain";
import { letterTemplateSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ templates: await listLetterTemplates(sq, ctx), kinds: LETTER_KINDS, variables: VARIABLES }));
export const POST = api({ body: letterTemplateSchema, idempotent: true }, async ({ ctx, sq, body }) => saveLetterTemplate(sq, ctx, body));
