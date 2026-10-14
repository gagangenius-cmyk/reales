import { voidReferral } from "@reales/domain";
import { referralVoidSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof referralVoidSchema>({ body: referralVoidSchema }, async ({ ctx, sq, params, body }) => voidReferral(sq, ctx, uuid.parse(params.id), body.reason));
