import { listValuations, valuateUnit } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => ({ valuations: await listValuations(sq, ctx, uuid.parse(params.id)) }));
export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => valuateUnit(sq, ctx, uuid.parse(params.id)));
