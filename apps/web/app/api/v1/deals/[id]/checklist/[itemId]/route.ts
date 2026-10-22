import { updateChecklistItem } from "@reales/domain";
import { checklistItemUpdateSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PATCH = api<{ id: string; itemId: string }, typeof checklistItemUpdateSchema>({ body: checklistItemUpdateSchema }, async ({ ctx, sq, params, body }) => updateChecklistItem(sq, ctx, z.string().uuid().parse(params.itemId), body));
