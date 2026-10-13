import { generateOwnerStatement } from "@reales/domain";
import { statementSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof statementSchema>({ body: statementSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await generateOwnerStatement(sq, ctx, uuid.parse(params.id), body.period) }));
