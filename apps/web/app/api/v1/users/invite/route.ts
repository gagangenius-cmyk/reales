import { inviteUser } from "@reales/domain";
import { inviteSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: inviteSchema, idempotent: true }, async ({ req, ctx, sq, body }) => ({ status: 201, data: await inviteUser(sq, ctx, { ...body, baseUrl: process.env.APP_URL ?? req.nextUrl.origin }) }));
