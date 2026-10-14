import { setSsoConnectionStatus } from "@reales/domain";
import { ssoStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof ssoStatusSchema>({ body: ssoStatusSchema }, async ({ ctx, sq, params, body }) => setSsoConnectionStatus(sq, ctx, z.string().uuid().parse(params.id), body.status));
