import { getLeadScore, scoreLead } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getLeadScore(sq, ctx, uuid.parse(params.id)));
export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => scoreLead(sq, ctx, uuid.parse(params.id)));
