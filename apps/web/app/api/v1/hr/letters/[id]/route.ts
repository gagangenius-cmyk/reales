import { deleteLetterDraft, updateLetterDraft } from "@reales/domain";
import { letterPatchSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PATCH = api<{ id: string }, typeof letterPatchSchema>({ body: letterPatchSchema }, async ({ ctx, sq, params, body }) => updateLetterDraft(sq, ctx, z.string().uuid().parse(params.id), body));
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => deleteLetterDraft(sq, ctx, z.string().uuid().parse(params.id)));
