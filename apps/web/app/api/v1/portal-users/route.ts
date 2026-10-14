import { invitePortalUser, listPortalUsers } from "@reales/domain";
import { portalInviteSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ users: await listPortalUsers(sq, ctx) }));
export const POST = api({ body: portalInviteSchema }, async ({ req, ctx, sq, body }) => ({ status: 201, data: await invitePortalUser(sq, ctx, { ...body, baseUrl: process.env.APP_URL ?? req.nextUrl.origin }) }));
