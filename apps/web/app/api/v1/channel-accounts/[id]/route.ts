import { setChannelAccountStatus } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const body = z.object({ status: z.enum(["active", "disabled"]) }).strict();
export const PATCH = api<{ id: string }, typeof body>({ body }, async ({ ctx, sq, params, body: b }) => setChannelAccountStatus(sq, ctx, z.string().uuid().parse(params.id), b.status));
