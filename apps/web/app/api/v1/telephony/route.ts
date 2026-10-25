import { getTelephony, saveTelephony } from "@reales/domain";
import { telephonySchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ telephony: await getTelephony(sq, ctx) }));
export const PUT = api({ body: telephonySchema, idempotent: true }, async ({ ctx, sq, body }) => ({ telephony: await saveTelephony(sq, ctx, body) }));
