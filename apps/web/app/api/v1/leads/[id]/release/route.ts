import { releaseToPool } from "@reales/domain";
import { releaseSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof releaseSchema>({ body: releaseSchema }, async ({ ctx, sq, params, body }) => releaseToPool(sq, ctx, z.string().uuid().parse(params.id), body.poolId, body.reason));
