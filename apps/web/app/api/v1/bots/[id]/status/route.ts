import { setBotStatus } from "@reales/domain";
import { botStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof botStatusSchema>({ body: botStatusSchema }, async ({ ctx, sq, params, body }) => setBotStatus(sq, ctx, uuid.parse(params.id), body.status));
