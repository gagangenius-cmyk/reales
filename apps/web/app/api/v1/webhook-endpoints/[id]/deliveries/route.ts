import { listWebhookDeliveries } from "@reales/domain";
import { webhookDeliveriesQuery, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }, undefined, typeof webhookDeliveriesQuery>({ query: webhookDeliveriesQuery }, async ({ ctx, sq, params, query }) => ({ deliveries: await listWebhookDeliveries(sq, ctx, z.string().uuid().parse(params.id), query.status) }));
