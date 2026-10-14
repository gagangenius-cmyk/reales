import { mobileSync } from "@reales/domain";
import { mobileSyncSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: mobileSyncSchema }, async ({ ctx, sq, body }) => mobileSync(sq, ctx, body.deviceId, body.mutations));
