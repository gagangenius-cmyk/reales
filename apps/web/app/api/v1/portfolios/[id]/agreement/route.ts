import { createManagementAgreement } from "@reales/domain";
import { agreementSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof agreementSchema>({ body: agreementSchema }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await createManagementAgreement(sq, ctx, { portfolioId: uuid.parse(params.id), ...body }) }));
