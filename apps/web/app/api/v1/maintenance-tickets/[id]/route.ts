import { getTicket } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getTicket(sq, ctx, z.string().uuid().parse(params.id)));
