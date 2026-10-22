import { cancelLeave } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }>({ idempotent: true }, async ({ ctx, sq, params }) => cancelLeave(sq, ctx, z.string().uuid().parse(params.id)));
