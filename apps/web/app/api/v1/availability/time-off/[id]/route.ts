import { removeTimeOff } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  await removeTimeOff(sq, ctx, z.string().uuid().parse(params.id));
  return { ok: true };
});
