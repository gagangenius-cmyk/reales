import { createPortalAccount, listPortalAccounts } from "@reales/domain";
import { portalAccountSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listPortalAccounts(sq, ctx));
export const POST = api({ body: portalAccountSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createPortalAccount(sq, ctx, body) }));
