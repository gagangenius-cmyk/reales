import { botReceive } from "@reales/domain";
import { botMessageSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof botMessageSchema>({ body: botMessageSchema }, async ({ ctx, sq, params, body }) => botReceive(sq, ctx, uuid.parse(params.id), body.text));
