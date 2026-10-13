import { verifyBrokerLicence } from "@reales/domain";
import { verifyLicenceSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof verifyLicenceSchema>({ body: verifyLicenceSchema }, async ({ ctx, sq, body, params }) =>
  verifyBrokerLicence(sq, ctx, uuid.parse(params.id), body.outcome),
);
