import { closeCase } from "@reales/domain";
import { caseCloseSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof caseCloseSchema>({ body: caseCloseSchema }, async ({ ctx, sq, params, body }) => closeCase(sq, ctx, uuid.parse(params.id), body));
