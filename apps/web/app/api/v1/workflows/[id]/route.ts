import { getWorkflow, saveDraft } from "@reales/domain";
import { draftSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getWorkflow(sq, ctx, uuid.parse(params.id)));
/** Saves the editable canvas only; nothing runs until a version is published. */
export const PUT = api<{ id: string }, typeof draftSchema>({ body: draftSchema }, async ({ ctx, sq, body, params }) => saveDraft(sq, ctx, uuid.parse(params.id), body.graph as any));
