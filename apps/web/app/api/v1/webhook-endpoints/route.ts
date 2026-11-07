import { listWebhookEndpoints, saveWebhookEndpoint } from "@reales/domain";
import { webhookEndpointSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ endpoints: await listWebhookEndpoints(sq, ctx) }));
export const POST = api({ body: webhookEndpointSchema }, async ({ ctx, sq, body }) => ({ status: body.id ? 200 : 201, data: await saveWebhookEndpoint(sq, ctx, body) }));
