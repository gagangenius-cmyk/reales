import { startCall } from "@reales/domain";
import { dialSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: dialSchema, idempotent: true, limit: { limit: 30, windowSec: 60, key: "dial" } }, async ({ ctx, sq, body }) => ({ status: 201, data: await startCall(sq, ctx, body) }));
