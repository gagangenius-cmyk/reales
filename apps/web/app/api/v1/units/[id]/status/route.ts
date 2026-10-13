import { setUnitStatus } from "@reales/domain";
import { unitStatusSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof unitStatusSchema>({ body: unitStatusSchema }, async ({ ctx, sq, body, params }) =>
  setUnitStatus(sq, ctx, uuid.parse(params.id), body.status, body.reason),
);
