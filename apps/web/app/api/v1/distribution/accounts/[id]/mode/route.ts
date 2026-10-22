import { setPortalMode } from "@reales/domain";
import { portalModeSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api<{ id: string }, typeof portalModeSchema>({ body: portalModeSchema }, async ({ ctx, sq, params, body }) => {
  await setPortalMode(sq, ctx, z.string().uuid().parse(params.id), body.mode);
  return { ok: true };
});
