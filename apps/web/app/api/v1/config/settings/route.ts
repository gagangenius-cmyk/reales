import { setSettings } from "@reales/domain";
import { configSettingsSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api({ body: configSettingsSchema, idempotent: true }, async ({ ctx, sq, body }) => setSettings(sq, ctx, body.settings));
