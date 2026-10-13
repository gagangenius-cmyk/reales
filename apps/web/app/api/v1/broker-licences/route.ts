import { addBrokerLicence } from "@reales/domain";
import { licenceSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: licenceSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await addBrokerLicence(sq, ctx, body) }));
