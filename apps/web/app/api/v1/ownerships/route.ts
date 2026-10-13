import { assignOwnership } from "@reales/domain";
import { ownershipSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: ownershipSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await assignOwnership(sq, ctx, body) }));
