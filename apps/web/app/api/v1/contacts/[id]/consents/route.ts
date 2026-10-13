import { listConsent, recordConsent } from "@reales/domain";
import { consentSchema, z } from "@reales/validation";
import { api, clientIp } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => listConsent(sq, ctx, uuid.parse(params.id)));
export const POST = api<{ id: string }, typeof consentSchema>({ body: consentSchema }, async ({ ctx, sq, body, params, req }) => ({
  status: 201,
  data: await recordConsent(sq, ctx, { ...body, contactId: uuid.parse(params.id), ip: clientIp(req), userAgent: req.headers.get("user-agent") }),
}));
