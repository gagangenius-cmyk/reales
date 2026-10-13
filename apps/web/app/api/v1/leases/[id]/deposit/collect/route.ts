import { collectDeposit } from "@reales/domain";
import { depositCollectSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof depositCollectSchema>({ body: depositCollectSchema }, async ({ ctx, sq, params, body }) => collectDeposit(sq, ctx, uuid.parse(params.id), body));
