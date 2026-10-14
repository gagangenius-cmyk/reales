import { revealIdentity } from "@reales/domain";
import { identityRevealSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof identityRevealSchema>({ body: identityRevealSchema }, async ({ ctx, sq, params, body }) => revealIdentity(sq, ctx, uuid.parse(params.id), body.reason));
