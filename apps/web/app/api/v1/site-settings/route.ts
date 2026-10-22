import { getSiteSettings, saveSiteSettings } from "@reales/domain";
import { siteSettingsSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => getSiteSettings(sq, ctx));
export const PUT = api({ body: siteSettingsSchema }, async ({ ctx, sq, body }) => saveSiteSettings(sq, ctx, body));
