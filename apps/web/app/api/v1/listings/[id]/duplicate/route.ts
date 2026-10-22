import { duplicateListing } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const body = z.object({ purpose: z.enum(["sale", "rent"]).optional() }).strict();

export const POST = api<{ id: string }, typeof body>({ body }, async ({ ctx, sq, params, body: b }) => ({ status: 201, data: await duplicateListing(sq, ctx, z.string().uuid().parse(params.id), b.purpose) }));
