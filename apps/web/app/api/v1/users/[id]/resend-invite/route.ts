import { resendInvite } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }>({}, async ({ req, ctx, sq, params }) => resendInvite(sq, ctx, z.string().uuid().parse(params.id), process.env.APP_URL ?? req.nextUrl.origin));
