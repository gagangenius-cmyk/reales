import { createSsoConnection, listSsoConnections } from "@reales/domain";
import { ssoConnectionSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ connections: await listSsoConnections(sq, ctx) }));
export const POST = api({ body: ssoConnectionSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createSsoConnection(sq, ctx, body) }));
