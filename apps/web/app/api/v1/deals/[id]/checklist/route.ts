import { addChecklistItem, getDealChecklist } from "@reales/domain";
import { checklistItemAddSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getDealChecklist(sq, ctx, id.parse(params.id)));
export const POST = api<{ id: string }, typeof checklistItemAddSchema>({ body: checklistItemAddSchema, idempotent: true }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addChecklistItem(sq, ctx, id.parse(params.id), body) }));
