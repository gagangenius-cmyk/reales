import { moveDocument } from "@reales/domain";
import { moveDocumentSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof moveDocumentSchema>({ body: moveDocumentSchema, idempotent: true }, async ({ ctx, sq, params, body }) => moveDocument(sq, ctx, z.string().uuid().parse(params.id), body.folderId));
