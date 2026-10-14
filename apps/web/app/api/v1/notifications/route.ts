import { listMyNotifications } from "@reales/domain";
import { notificationQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: notificationQuery }, async ({ ctx, sq, query }) => ({ notifications: await listMyNotifications(sq, ctx, query) }));
