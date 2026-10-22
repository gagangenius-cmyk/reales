import { setIngestSourceActive } from "@reales/domain";
import { ingestSourcePatchSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const PATCH = api<{ id: string }, typeof ingestSourcePatchSchema>({ body: ingestSourcePatchSchema }, async ({ ctx, sq, params, body }) => {
  await setIngestSourceActive(sq, ctx, z.string().uuid().parse(params.id), body.active);
  return { ok: true };
});
