import { updateGoogleSettings } from "@reales/domain";
import { googleSettingsSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: googleSettingsSchema }, async ({ ctx, sq, body }) => updateGoogleSettings(sq, ctx, body));
