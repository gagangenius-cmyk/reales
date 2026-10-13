import { deductDeposit } from "@reales/domain";
import { depositDeductSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof depositDeductSchema>({ body: depositDeductSchema }, async ({ ctx, sq, params, body }) => deductDeposit(sq, ctx, uuid.parse(params.id), body));
