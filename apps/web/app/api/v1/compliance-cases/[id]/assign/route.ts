import { assignCase } from "@reales/domain";
import { caseAssignSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof caseAssignSchema>({ body: caseAssignSchema }, async ({ ctx, sq, params, body }) => assignCase(sq, ctx, uuid.parse(params.id), body.userId));
