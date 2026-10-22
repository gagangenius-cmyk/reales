import { deleteOccasion } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => deleteOccasion(sq, ctx, z.string().uuid().parse(params.id)));
