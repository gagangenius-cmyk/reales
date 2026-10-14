import { disposeHit } from "@reales/domain";
import { hitDisposeSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof hitDisposeSchema>({ body: hitDisposeSchema }, async ({ ctx, sq, params, body }) => disposeHit(sq, ctx, uuid.parse(params.id), body));
