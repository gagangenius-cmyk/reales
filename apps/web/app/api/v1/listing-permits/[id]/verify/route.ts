import { verifyPermit } from "@reales/domain";
import { verifyPermitSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof verifyPermitSchema>({ body: verifyPermitSchema }, async ({ ctx, sq, body, params }) =>
  verifyPermit(sq, ctx, uuid.parse(params.id), body.outcome),
);
