import { rejectOffer } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => rejectOffer(sq, ctx, uuid.parse(params.id)));
