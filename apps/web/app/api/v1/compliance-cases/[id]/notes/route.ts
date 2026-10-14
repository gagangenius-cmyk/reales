import { addCaseNote } from "@reales/domain";
import { caseNoteSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof caseNoteSchema>({ body: caseNoteSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addCaseNote(sq, ctx, uuid.parse(params.id), body.note) }));
